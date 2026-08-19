# Workspace filesystem design

This document defines the internal capability-rooted filesystem foundation used by future workspace-edit application. It is development-facing and is not published in the documentation site or npm package.

## Scope

`src/core/workspace-fs/` exposes a typed TypeScript wrapper over the Rust Node-API addon in `native/workspace-fs/`. It does not change the existing `read`, `edit`, or `write` tools. Those tools intentionally retain their current absolute-path and injectable-operation contracts.

The foundation provides:

- following metadata and non-following `lstat`;
- complete-file reads and directory reads;
- exclusive file creation;
- atomic complete-file replacement;
- file or directory rename with explicit overwrite/no-overwrite behavior;
- non-following file, symlink, empty-directory, and recursive-directory removal;
- explicit close and asynchronous disposal.

It is not a general `node:fs` replacement and does not expose ambient absolute-path operations after construction.

## Root capability and path contract

The host supplies one trusted absolute workspace root. The native constructor opens that directory once with ambient authority and retains the resulting `cap_std::fs::Dir`. Every operation clones or descends from that retained handle rather than resolving an ambient path from the process working directory.

Operation paths use `/` separators and must already be normalized portable relative paths. Empty paths, absolute paths, drive/stream prefixes, backslashes, repeated or trailing separators, and `.` or `..` components are rejected before native dispatch and again by the native boundary. `.` denotes the retained root only for metadata and directory reads. It is never a mutation target.

The confinement guarantee is descriptor-relative authority: a component race cannot redirect an operation to an object that was not reachable beneath the retained root while that component was resolved.

## Symlinks and entry operations

Operations are divided by whether the final component is dereferenced.

Dereferencing operations are following metadata, file reads, and directory reads. They may follow relative symlinks while resolution remains beneath the retained root. Absolute symlinks, dangling symlinks, and relative symlinks that escape above the root fail. Intermediate component resolution follows the same rule.

Entry operations are exclusive create, complete-file replacement, rename, and removal. Parent components may use permitted in-root symlinks, but the final entry is not followed:

- creating a file fails if any entry, including a symlink, already occupies the name;
- replacing a symlink publishes a new regular-file entry in place of the symlink;
- renaming a symlink renames the link entry, not its target;
- removing a symlink removes the link entry, including when recursive removal was requested.

Recursive removal uses handle-relative traversal and does not descend through symlinks encountered in the tree.

## Mounts, hard links, and reparenting

Mounted filesystems reachable below the retained root are authorized. Crossing a mount boundary is not treated as an escape because the mounted subtree is part of the namespace delegated by the root capability.

Hard links are entries for an already-authorized inode. Ordinary reads and entry operations therefore have normal hard-link semantics. Complete-file replacement is intentionally different: it writes a new sibling temporary inode and renames that inode over the destination. Replacing one hard-link entry does not modify content visible through another alias, including an alias outside the workspace.

A hostile same-user process can rename an object after Volt has opened it. Operations already admitted against an opened directory capability continue against that object even if it is subsequently reparented. The guarantee is capability-relative confinement, not that an already-open object still has a current pathname below the original root. Preventing a process with equivalent filesystem authority from reparenting opened objects requires OS sandboxing outside this API.

## Replacement and metadata

Complete-file replacement creates an exclusive sibling temporary file, writes and synchronizes all bytes, applies the observed destination POSIX mode when replacing a regular file, and publishes with descriptor-relative rename. Readers observe either the old complete file or the new complete file at the destination name. A failed publish attempts to remove the temporary entry.

Replacement preserves only the existing regular file's ordinary POSIX access mode (`0o777`) where the platform exposes one. Temporary replacement files are created as `0o600`, and set-id/sticky bits are not carried onto newly written content. Replacement does not preserve inode identity, ownership, timestamps, ACLs, extended attributes, flags, alternate streams, or other metadata. A missing destination receives normal create-mode and umask behavior. Replacing a directory is rejected.

Rename without overwrite uses `renameat2(RENAME_NOREPLACE)` on Linux, `renameatx_np(RENAME_EXCL)` on macOS, and handle-relative Windows rename information with `ReplaceIfExists` disabled. Overwrite rename uses the platform's descriptor-relative replacement semantics. Cross-filesystem rename may fail with `EXDEV`.

## Errors, partial failure, and lifecycle

Native I/O failures are normalized with an operation, portable code, and relative path. The TypeScript wrapper throws `WorkspaceFsError` with those fields and retains the native error as its cause.

Multi-entry operations are not transactions. Recursive removal can remove some descendants before permissions, concurrent changes, I/O errors, or mount behavior cause a failure. Callers must report the failure and must not imply rollback. A future multi-file workspace edit must preserve its own precondition/conflict reporting and describe any already-applied operations.

`close()` synchronously prevents admission of later operations and releases the retained root handle after outstanding clones are dropped. Operations admitted before close are allowed to finish. `dispose()` is the asynchronous lifecycle form and is idempotent.

## Native loading and distribution

There is no JavaScript mutation fallback. Unsupported architectures/platforms, a missing addon, malformed manifests, API or source-fingerprint mismatch, and artifact checksum mismatch fail closed with `WorkspaceFsNativeUnavailableError`.

The npm package carries one checksum manifest, eight prebuilds (macOS arm64/x64, Windows arm64/x64 MSVC, Linux glibc arm64/x64, and Linux musl arm64/x64), and the generated Rust license inventory/texts. Standalone archives carry only the matching desktop/glibc addon, a target-filtered manifest, and the native license tree. Npm/source loading uses exactly the package-relative native root; standalone loading uses exactly the executable-relative native root. Windows writes verified addon bytes to a complete temporary file, atomically publishes one reusable content-addressed cache entry, verifies that entry again, and loads it from the user temporary directory so the package or worktree is not locked and repeated processes do not accumulate private copies.

## PR #279 handoff

After this foundation merges, rebase PR #279 onto it and route workspace-edit application through `src/core/workspace-fs/index.ts`:

1. Establish the trusted workspace root once from the host's workspace identity and construct one `WorkspaceRoot` for the apply lifecycle.
2. Convert each protocol path to the portable normalized path relative to that root. Reject paths that cannot be represented by this contract; do not retain canonical absolute paths as later mutation authority.
3. Use rooted metadata/read operations for edit preconditions and conflict detection.
4. Use `createFile`, `replaceFile`, `rename`, and `remove` for mutations. Complete text edits should publish through `replaceFile` rather than opening/truncating the validated pathname.
5. Preserve PR #279's operation ordering and user-visible conflict/partial-application reporting. Do not add a second path-validation-then-ambient-execution loop.
6. Close the root in the applier's `finally` path while allowing already-admitted work to settle.

The integration must not modify the public `edit` or `write` tool contracts and must not add an unsupported-platform or native-load fallback.
