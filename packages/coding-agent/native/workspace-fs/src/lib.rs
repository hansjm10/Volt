use cap_std::ambient_authority;
use cap_std::fs::{Dir, Metadata, OpenOptions, Permissions};
use napi::bindgen_prelude::{AsyncTask, Buffer, Task};
use napi::{Env, Error, Result, Status};
use napi_derive::napi;
use std::ffi::OsStr;
use std::io::{self, Write};
use std::path::{Component, Path};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const API_VERSION: &str = "volt-workspace-fs-v1";

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
compile_error!("volt-workspace-fs supports only Linux, macOS, and Windows");

fn error_code(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::PermissionDenied => "EACCES",
        io::ErrorKind::AlreadyExists => "EEXIST",
        io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => "EINVAL",
        io::ErrorKind::NotADirectory => "ENOTDIR",
        io::ErrorKind::IsADirectory => "EISDIR",
        io::ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
        io::ErrorKind::ReadOnlyFilesystem => "EROFS",
        io::ErrorKind::CrossesDevices => "EXDEV",
        _ => "EIO",
    }
}

fn napi_io_error(operation: &str, path: &str, error: io::Error) -> Error {
    Error::new(
        Status::GenericFailure,
        format!(
            "workspace-fs {operation} [{}] {path}: {error}",
            error_code(&error)
        ),
    )
}

fn invalid_path(operation: &str, path: &str, message: &str) -> Error {
    Error::new(
        Status::InvalidArg,
        format!("workspace-fs {operation} [EINVAL] {path}: {message}"),
    )
}

fn validate_relative_path(operation: &str, path: &str, allow_root: bool) -> Result<()> {
    if path == "." {
        return if allow_root {
            Ok(())
        } else {
            Err(invalid_path(
                operation,
                path,
                "the workspace root is not a valid target",
            ))
        };
    }
    if path.is_empty() {
        return Err(invalid_path(operation, path, "path must not be empty"));
    }
    if path.contains('\\') || path.contains('\0') {
        return Err(invalid_path(
            operation,
            path,
            "path must use portable forward-slash components",
        ));
    }
    if path.starts_with('/') || path.ends_with('/') || path.contains("//") {
        return Err(invalid_path(
            operation,
            path,
            "path must be normalized and relative",
        ));
    }
    for component in path.split('/') {
        if component == "." || component == ".." || component.contains(':') {
            return Err(invalid_path(
                operation,
                path,
                "path contains a non-portable or traversing component",
            ));
        }
    }
    let mut components = Path::new(path).components();
    if components.any(|component| !matches!(component, Component::Normal(_))) {
        return Err(invalid_path(
            operation,
            path,
            "path must be normalized and relative",
        ));
    }
    Ok(())
}

fn split_parent(path: &str) -> (&str, &str) {
    path.rsplit_once('/').unwrap_or((".", path))
}

fn open_parent(root: &Dir, operation: &str, path: &str) -> Result<(Dir, String)> {
    validate_relative_path(operation, path, false)?;
    let (parent, name) = split_parent(path);
    root.open_dir(parent)
        .map(|directory| (directory, name.to_owned()))
        .map_err(|error| napi_io_error(operation, path, error))
}

#[cfg(test)]
type TestOperationHook = Box<dyn FnOnce(&str)>;

#[cfg(test)]
thread_local! {
    static TEST_OPERATION_HOOK: std::cell::RefCell<Option<TestOperationHook>> =
        std::cell::RefCell::new(None);
}

#[cfg(all(test, unix))]
fn install_test_operation_hook(hook: impl FnOnce(&str) + 'static) {
    TEST_OPERATION_HOOK.with(|slot| {
        assert!(slot.replace(Some(Box::new(hook))).is_none());
    });
}

#[cfg(test)]
fn operation_hook(operation: &str) {
    TEST_OPERATION_HOOK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook(operation);
        }
    });
}

#[cfg(not(test))]
#[inline]
fn operation_hook(_operation: &str) {}

fn metadata_type(metadata: &Metadata) -> &'static str {
    let file_type = metadata.file_type();
    if file_type.is_file() {
        "file"
    } else if file_type.is_dir() {
        "directory"
    } else if file_type.is_symlink() {
        "symlink"
    } else {
        "other"
    }
}

#[cfg(unix)]
fn metadata_mode(metadata: &Metadata) -> Option<u32> {
    use cap_std::fs::MetadataExt;
    Some(metadata.mode())
}

#[cfg(windows)]
fn metadata_mode(_metadata: &Metadata) -> Option<u32> {
    None
}

#[cfg(unix)]
fn replacement_permissions(metadata: &Metadata) -> Option<Permissions> {
    use cap_std::fs::{MetadataExt, PermissionsExt};
    Some(Permissions::from_mode(metadata.mode() & 0o777))
}

#[cfg(windows)]
fn replacement_permissions(_metadata: &Metadata) -> Option<Permissions> {
    None
}

#[napi(object, object_from_js = false)]
pub struct NativeMetadata {
    pub file_type: String,
    pub size: f64,
    pub modified_ms: f64,
    pub mode: Option<u32>,
}

fn epoch_milliseconds(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1000.0,
        Err(error) => -error.duration().as_secs_f64() * 1000.0,
    }
}

fn metadata_output(metadata: Metadata) -> io::Result<NativeMetadata> {
    let modified_ms = epoch_milliseconds(metadata.modified()?.into_std());
    Ok(NativeMetadata {
        file_type: metadata_type(&metadata).to_owned(),
        size: metadata.len() as f64,
        modified_ms,
        mode: metadata_mode(&metadata),
    })
}

#[napi(object, object_from_js = false)]
pub struct NativeDirectoryEntry {
    pub name: String,
    pub file_type: String,
}

struct RootState {
    root: Mutex<Option<Dir>>,
}

impl RootState {
    fn acquire(&self, operation: &str, path: &str) -> Result<Dir> {
        let guard = self.root.lock().map_err(|_| {
            Error::new(
                Status::GenericFailure,
                format!("workspace-fs {operation} [EIO] {path}: root lock is poisoned"),
            )
        })?;
        let root = guard.as_ref().ok_or_else(|| {
            Error::new(
                Status::GenericFailure,
                format!("workspace-fs {operation} [ECLOSED] {path}: workspace root is closed"),
            )
        })?;
        root.try_clone()
            .map_err(|error| napi_io_error(operation, path, error))
    }

    fn close(&self) -> Result<bool> {
        let mut guard = self.root.lock().map_err(|_| {
            Error::new(
                Status::GenericFailure,
                "workspace-fs close [EIO] .: root lock is poisoned".to_owned(),
            )
        })?;
        Ok(guard.take().is_some())
    }
}

pub struct MetadataTask {
    root: Dir,
    path: String,
    follow: bool,
}

impl Task for MetadataTask {
    type Output = NativeMetadata;
    type JsValue = NativeMetadata;

    fn compute(&mut self) -> Result<Self::Output> {
        validate_relative_path(
            if self.follow { "metadata" } else { "lstat" },
            &self.path,
            true,
        )?;
        let result = if self.path == "." {
            self.root.dir_metadata()
        } else {
            let operation = if self.follow { "metadata" } else { "lstat" };
            let (parent, name) = open_parent(&self.root, operation, &self.path)?;
            operation_hook(operation);
            if self.follow {
                parent.metadata(&name)
            } else {
                parent.symlink_metadata(&name)
            }
        };
        result.and_then(metadata_output).map_err(|error| {
            napi_io_error(
                if self.follow { "metadata" } else { "lstat" },
                &self.path,
                error,
            )
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct ReadFileTask {
    root: Dir,
    path: String,
}

impl Task for ReadFileTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        let (parent, name) = open_parent(&self.root, "readFile", &self.path)?;
        operation_hook("readFile");
        parent
            .read(&name)
            .map_err(|error| napi_io_error("readFile", &self.path, error))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.into())
    }
}

pub struct ReadDirectoryTask {
    root: Dir,
    path: String,
}

impl Task for ReadDirectoryTask {
    type Output = Vec<NativeDirectoryEntry>;
    type JsValue = Vec<NativeDirectoryEntry>;

    fn compute(&mut self) -> Result<Self::Output> {
        validate_relative_path("readDirectory", &self.path, true)?;
        let directory = if self.path == "." {
            self.root
                .try_clone()
                .map_err(|error| napi_io_error("readDirectory", &self.path, error))?
        } else {
            let (parent, name) = open_parent(&self.root, "readDirectory", &self.path)?;
            operation_hook("readDirectory");
            parent
                .open_dir(&name)
                .map_err(|error| napi_io_error("readDirectory", &self.path, error))?
        };
        let entries = directory
            .entries()
            .map_err(|error| napi_io_error("readDirectory", &self.path, error))?;
        let mut output = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| napi_io_error("readDirectory", &self.path, error))?;
            let name = entry.file_name().into_string().map_err(|_| {
                Error::new(
                    Status::InvalidArg,
                    format!(
                        "workspace-fs readDirectory [EINVAL] {}: directory entry is not valid UTF-8",
                        self.path
                    ),
                )
            })?;
            let file_type = entry
                .file_type()
                .map_err(|error| napi_io_error("readDirectory", &self.path, error))?;
            let file_type = if file_type.is_file() {
                "file"
            } else if file_type.is_dir() {
                "directory"
            } else if file_type.is_symlink() {
                "symlink"
            } else {
                "other"
            };
            output.push(NativeDirectoryEntry {
                name,
                file_type: file_type.to_owned(),
            });
        }
        output.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(output)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct CreateFileTask {
    root: Dir,
    path: String,
    data: Vec<u8>,
}

impl Task for CreateFileTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        let (parent, name) = open_parent(&self.root, "createFile", &self.path)?;
        operation_hook("createFile");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        let mut file = parent
            .open_with(&name, &options)
            .map_err(|error| napi_io_error("createFile", &self.path, error))?;
        file.write_all(&self.data)
            .and_then(|()| file.sync_all())
            .map_err(|error| napi_io_error("createFile", &self.path, error))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

static TEMPORARY_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn temporary_name() -> String {
    let counter = TEMPORARY_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let token = std::process::id()
        .wrapping_mul(0x9e37_79b9)
        .wrapping_add(counter);
    format!(".v{token:08x}")
}

#[cfg(unix)]
fn default_creation_permissions(parent: &Dir) -> io::Result<Permissions> {
    use cap_std::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    loop {
        let probe = temporary_name();
        let mut options = OpenOptions::new();
        options.write(true).create_new(true).mode(0o666);
        let file = match parent.open_with(&probe, &options) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let permissions = file
            .metadata()
            .map(|metadata| Permissions::from_mode(metadata.mode() & 0o777));
        drop(file);
        let cleanup = parent.remove_file(&probe);
        let permissions = permissions?;
        cleanup?;
        return Ok(permissions);
    }
}

fn replace_file(root: &Dir, path: &str, data: &[u8]) -> Result<()> {
    let (parent, destination) = open_parent(root, "replaceFile", path)?;
    operation_hook("replaceFile");
    let existing_permissions = match parent.symlink_metadata(&destination) {
        Ok(metadata) if metadata.file_type().is_file() => replacement_permissions(&metadata),
        Ok(metadata) if metadata.file_type().is_dir() => {
            return Err(napi_io_error(
                "replaceFile",
                path,
                io::Error::new(io::ErrorKind::IsADirectory, "destination is a directory"),
            ));
        }
        Ok(_) => None,
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(napi_io_error("replaceFile", path, error)),
    };
    #[cfg(unix)]
    let publish_permissions = match existing_permissions {
        Some(permissions) => Some(permissions),
        None => Some(
            default_creation_permissions(&parent)
                .map_err(|error| napi_io_error("replaceFile", path, error))?,
        ),
    };
    #[cfg(windows)]
    let publish_permissions = existing_permissions;

    let (temporary, mut file) = loop {
        let temporary = temporary_name();
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match parent.open_with(&temporary, &options) {
            Ok(file) => break (temporary, file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(napi_io_error("replaceFile", path, error)),
        }
    };

    let publish = (|| -> io::Result<()> {
        file.write_all(data)?;
        if let Some(permissions) = publish_permissions {
            file.set_permissions(permissions)?;
        }
        file.sync_all()?;
        drop(file);
        parent.rename(&temporary, &parent, &destination)
    })();

    if let Err(error) = publish {
        let _ = parent.remove_file(&temporary);
        return Err(napi_io_error("replaceFile", path, error));
    }
    Ok(())
}

pub struct ReplaceFileTask {
    root: Dir,
    path: String,
    data: Vec<u8>,
}

impl Task for ReplaceFileTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        replace_file(&self.root, &self.path, &self.data)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(target_os = "linux")]
fn rename_no_replace(
    old_parent: &Dir,
    old_name: &OsStr,
    new_parent: &Dir,
    new_name: &OsStr,
) -> io::Result<()> {
    use rustix::fs::{RenameFlags, renameat_with};
    renameat_with(
        old_parent,
        old_name,
        new_parent,
        new_name,
        RenameFlags::NOREPLACE,
    )
    .map_err(io::Error::from)
}

#[cfg(target_os = "macos")]
fn rename_no_replace(
    old_parent: &Dir,
    old_name: &OsStr,
    new_parent: &Dir,
    new_name: &OsStr,
) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;

    const RENAME_EXCL: u32 = 0x0000_0004;
    unsafe extern "C" {
        fn renameatx_np(
            from_fd: i32,
            from: *const i8,
            to_fd: i32,
            to: *const i8,
            flags: u32,
        ) -> i32;
    }

    let old_name = CString::new(old_name.as_bytes())?;
    let new_name = CString::new(new_name.as_bytes())?;
    // SAFETY: Both names are NUL-terminated immediate entry names and both
    // descriptors remain borrowed for the duration of the syscall.
    let result = unsafe {
        renameatx_np(
            old_parent.as_raw_fd(),
            old_name.as_ptr(),
            new_parent.as_raw_fd(),
            new_name.as_ptr(),
            RENAME_EXCL,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(target_os = "windows")]
fn rename_no_replace(
    old_parent: &Dir,
    old_name: &OsStr,
    new_parent: &Dir,
    new_name: &OsStr,
) -> io::Result<()> {
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::ptr::{copy_nonoverlapping, null_mut};

    type Handle = *mut std::ffi::c_void;
    type NtStatus = i32;

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }

    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root_directory: Handle,
        object_name: *mut UnicodeString,
        attributes: u32,
        security_descriptor: Handle,
        security_quality_of_service: Handle,
    }

    #[repr(C)]
    struct IoStatusBlock {
        status: usize,
        information: usize,
    }

    #[repr(C)]
    struct FileRenameInfo {
        flags: u32,
        root_directory: Handle,
        file_name_length: u32,
        file_name: [u16; 1],
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtOpenFile(
            file_handle: *mut Handle,
            desired_access: u32,
            object_attributes: *mut ObjectAttributes,
            io_status_block: *mut IoStatusBlock,
            share_access: u32,
            open_options: u32,
        ) -> NtStatus;
        fn NtSetInformationFile(
            file_handle: Handle,
            io_status_block: *mut IoStatusBlock,
            file_information: *const std::ffi::c_void,
            length: u32,
            file_information_class: i32,
        ) -> NtStatus;
        fn RtlNtStatusToDosError(status: NtStatus) -> u32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CloseHandle(handle: Handle) -> i32;
    }

    const DELETE: u32 = 0x0001_0000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_SHARE_ALL: u32 = 0x0000_0007;
    const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
    const FILE_OPEN_FOR_BACKUP_INTENT: u32 = 0x0000_4000;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;
    const FILE_RENAME_INFORMATION_CLASS: i32 = 10;

    let mut old_wide = old_name.encode_wide().collect::<Vec<_>>();
    let old_bytes = old_wide
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "source entry name is too long")
        })?;
    let mut old_unicode = UnicodeString {
        length: old_bytes,
        maximum_length: old_bytes,
        buffer: old_wide.as_mut_ptr(),
    };
    let mut attributes = ObjectAttributes {
        length: size_of::<ObjectAttributes>() as u32,
        root_directory: old_parent.as_raw_handle(),
        object_name: &mut old_unicode,
        attributes: OBJ_CASE_INSENSITIVE,
        security_descriptor: null_mut(),
        security_quality_of_service: null_mut(),
    };
    let mut status_block = IoStatusBlock {
        status: 0,
        information: 0,
    };
    let mut source_handle: Handle = null_mut();
    // SAFETY: The object attributes and UTF-16 leaf name remain alive for the
    // call, and the root handle is a retained directory capability.
    let status = unsafe {
        NtOpenFile(
            &mut source_handle,
            DELETE | SYNCHRONIZE,
            &mut attributes,
            &mut status_block,
            FILE_SHARE_ALL,
            FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT | FILE_OPEN_REPARSE_POINT,
        )
    };
    if status < 0 {
        // SAFETY: RtlNtStatusToDosError accepts any NTSTATUS value.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }

    let new_wide = new_name.encode_wide().collect::<Vec<_>>();
    let name_bytes = new_wide
        .len()
        .checked_mul(size_of::<u16>())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "destination entry name is too long",
            )
        })?;
    let root_offset = std::mem::offset_of!(FileRenameInfo, root_directory);
    let length_offset = std::mem::offset_of!(FileRenameInfo, file_name_length);
    let name_offset = std::mem::offset_of!(FileRenameInfo, file_name);
    // Windows requires sizeof(FILE_RENAME_INFO) plus the complete file-name
    // byte length, even though the fixed structure already contains WCHAR[1].
    let total_size = size_of::<FileRenameInfo>()
        .checked_add(name_bytes)
        .and_then(|length| u32::try_from(length).ok())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "rename information is too large",
            )
        })?;
    let mut information = vec![0u8; total_size as usize];
    // ReplaceIfExists is false because the zero-filled flags field remains 0.
    // SAFETY: Every write is within the explicitly sized byte buffer and uses
    // unaligned writes where the Windows ABI permits packed trailing data.
    unsafe {
        std::ptr::write_unaligned(
            information.as_mut_ptr().add(root_offset).cast::<Handle>(),
            new_parent.as_raw_handle(),
        );
        std::ptr::write_unaligned(
            information.as_mut_ptr().add(length_offset).cast::<u32>(),
            name_bytes as u32,
        );
        copy_nonoverlapping(
            new_wide.as_ptr().cast::<u8>(),
            information.as_mut_ptr().add(name_offset),
            name_bytes,
        );
    }
    let mut rename_status_block = IoStatusBlock {
        status: 0,
        information: 0,
    };
    // SAFETY: source_handle is valid after successful NtOpenFile, the
    // information buffer follows FILE_RENAME_INFORMATION's ABI layout, and
    // the destination directory capability remains borrowed for the call.
    let status = unsafe {
        NtSetInformationFile(
            source_handle,
            &mut rename_status_block,
            information.as_ptr().cast(),
            total_size,
            FILE_RENAME_INFORMATION_CLASS,
        )
    };
    let error = if status < 0 {
        // SAFETY: RtlNtStatusToDosError accepts any NTSTATUS value.
        Some(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ))
    } else {
        None
    };
    // SAFETY: source_handle is owned by this function after NtOpenFile.
    unsafe { CloseHandle(source_handle) };
    error.map_or(Ok(()), Err)
}

fn rename_entry(root: &Dir, old_path: &str, new_path: &str, overwrite: bool) -> Result<()> {
    let (old_parent, old_name) = open_parent(root, "rename", old_path)?;
    let (new_parent, new_name) = open_parent(root, "rename", new_path)?;
    operation_hook("rename");
    let result = if overwrite {
        old_parent.rename(&old_name, &new_parent, &new_name)
    } else {
        rename_no_replace(
            &old_parent,
            OsStr::new(&old_name),
            &new_parent,
            OsStr::new(&new_name),
        )
    };
    result.map_err(|error| napi_io_error("rename", old_path, error))
}

pub struct RenameTask {
    root: Dir,
    old_path: String,
    new_path: String,
    overwrite: bool,
}

impl Task for RenameTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        rename_entry(&self.root, &self.old_path, &self.new_path, self.overwrite)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

fn remove_entry(root: &Dir, path: &str, recursive: bool) -> Result<()> {
    let (parent, name) = open_parent(root, "remove", path)?;
    operation_hook("remove");
    let metadata = parent
        .symlink_metadata(&name)
        .map_err(|error| napi_io_error("remove", path, error))?;
    let result = if metadata.file_type().is_dir() {
        if recursive {
            parent.remove_dir_all(&name)
        } else {
            parent.remove_dir(&name)
        }
    } else {
        parent.remove_file(&name)
    };
    result.map_err(|error| napi_io_error("remove", path, error))
}

pub struct RemoveTask {
    root: Dir,
    path: String,
    recursive: bool,
}

impl Task for RemoveTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        remove_entry(&self.root, &self.path, self.recursive)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "workspaceFsApiVersion")]
pub fn workspace_fs_api_version() -> &'static str {
    API_VERSION
}

#[napi(js_name = "workspaceFsSourceFingerprint")]
pub fn workspace_fs_source_fingerprint() -> &'static str {
    env!("VOLT_WORKSPACE_FS_SOURCE_FINGERPRINT")
}

#[napi(
    js_name = "WorkspaceRoot",
    type_tag = "69b78bcf-5c15-44f2-935d-a3f1a0631cb2"
)]
pub struct NativeWorkspaceRoot {
    state: Arc<RootState>,
}

#[napi]
impl NativeWorkspaceRoot {
    #[napi(constructor)]
    pub fn new(root_path: String) -> Result<Self> {
        let path = Path::new(&root_path);
        if !path.is_absolute() {
            return Err(invalid_path(
                "open",
                &root_path,
                "workspace root must be absolute",
            ));
        }
        let root = Dir::open_ambient_dir(path, ambient_authority())
            .map_err(|error| napi_io_error("open", &root_path, error))?;
        Ok(Self {
            state: Arc::new(RootState {
                root: Mutex::new(Some(root)),
            }),
        })
    }

    #[napi]
    pub fn lstat(&self, path: String) -> Result<AsyncTask<MetadataTask>> {
        Ok(AsyncTask::new(MetadataTask {
            root: self.state.acquire("lstat", &path)?,
            path,
            follow: false,
        }))
    }

    #[napi]
    pub fn metadata(&self, path: String) -> Result<AsyncTask<MetadataTask>> {
        Ok(AsyncTask::new(MetadataTask {
            root: self.state.acquire("metadata", &path)?,
            path,
            follow: true,
        }))
    }

    #[napi]
    pub fn read_file(&self, path: String) -> Result<AsyncTask<ReadFileTask>> {
        Ok(AsyncTask::new(ReadFileTask {
            root: self.state.acquire("readFile", &path)?,
            path,
        }))
    }

    #[napi]
    pub fn read_directory(&self, path: String) -> Result<AsyncTask<ReadDirectoryTask>> {
        Ok(AsyncTask::new(ReadDirectoryTask {
            root: self.state.acquire("readDirectory", &path)?,
            path,
        }))
    }

    #[napi]
    pub fn create_file(&self, path: String, data: Buffer) -> Result<AsyncTask<CreateFileTask>> {
        Ok(AsyncTask::new(CreateFileTask {
            root: self.state.acquire("createFile", &path)?,
            path,
            data: data.to_vec(),
        }))
    }

    #[napi]
    pub fn replace_file(&self, path: String, data: Buffer) -> Result<AsyncTask<ReplaceFileTask>> {
        Ok(AsyncTask::new(ReplaceFileTask {
            root: self.state.acquire("replaceFile", &path)?,
            path,
            data: data.to_vec(),
        }))
    }

    #[napi]
    pub fn rename(
        &self,
        old_path: String,
        new_path: String,
        overwrite: bool,
    ) -> Result<AsyncTask<RenameTask>> {
        Ok(AsyncTask::new(RenameTask {
            root: self.state.acquire("rename", &old_path)?,
            old_path,
            new_path,
            overwrite,
        }))
    }

    #[napi]
    pub fn remove(&self, path: String, recursive: bool) -> Result<AsyncTask<RemoveTask>> {
        Ok(AsyncTask::new(RemoveTask {
            root: self.state.acquire("remove", &path)?,
            path,
            recursive,
        }))
    }

    #[napi]
    pub fn close(&self) -> Result<bool> {
        self.state.close()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn open_fixture(path: &Path) -> Dir {
        Dir::open_ambient_dir(path, ambient_authority()).expect("open fixture root")
    }

    #[test]
    fn validates_portable_relative_paths() {
        for invalid in [
            "",
            "/absolute",
            "../escape",
            "a/../b",
            "a//b",
            "a\\b",
            "C:/escape",
            "a/",
        ] {
            assert!(
                validate_relative_path("test", invalid, false).is_err(),
                "{invalid}"
            );
        }
        assert!(validate_relative_path("test", ".", true).is_ok());
        assert!(validate_relative_path("test", ".", false).is_err());
        assert!(validate_relative_path("test", "a/b", false).is_ok());
    }

    #[test]
    fn replacement_supports_near_limit_destination_names() {
        let fixture = tempdir().expect("tempdir");
        let name = "a".repeat(240);
        let root = open_fixture(fixture.path());
        root.write(&name, b"before").expect("write fixture");

        replace_file(&root, &name, b"after").expect("replace file");

        assert_eq!(root.read(&name).expect("read replacement"), b"after");
        let entries = root
            .entries()
            .expect("read fixture entries")
            .map(|entry| entry.expect("read fixture entry").file_name())
            .collect::<Vec<_>>();
        assert_eq!(entries, [std::ffi::OsString::from(name)]);
    }

    #[test]
    fn replacement_uses_a_new_inode_and_preserves_mode() {
        let fixture = tempdir().expect("tempdir");
        let path = fixture.path().join("file.txt");
        fs::write(&path, b"before").expect("write fixture");
        fs::hard_link(&path, fixture.path().join("alias.txt")).expect("hard link");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o4640)).expect("chmod fixture");
        }
        let root = open_fixture(fixture.path());
        replace_file(&root, "file.txt", b"after").expect("replace file");
        assert_eq!(fs::read(&path).expect("read replacement"), b"after");
        assert_eq!(
            fs::read(fixture.path().join("alias.txt")).expect("read alias"),
            b"before"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).expect("metadata").permissions().mode() & 0o777,
                0o640
            );
        }
    }

    #[test]
    fn no_replace_rename_uses_the_destination_parent_capability() {
        let fixture = tempdir().expect("tempdir");
        fs::create_dir(fixture.path().join("from-directory")).expect("create source directory");
        fs::create_dir(fixture.path().join("to-directory")).expect("create destination directory");
        fs::write(fixture.path().join("from-directory/item"), b"content").expect("write source");
        let root = open_fixture(fixture.path());

        rename_entry(&root, "from-directory/item", "to-directory/renamed", false)
            .expect("rename into destination parent");

        assert!(!fixture.path().join("from-directory/item").exists());
        assert_eq!(
            fs::read(fixture.path().join("to-directory/renamed")).expect("read destination"),
            b"content"
        );
    }

    #[test]
    fn no_replace_rename_is_atomic_at_the_destination() {
        let fixture = tempdir().expect("tempdir");
        fs::write(fixture.path().join("from"), b"from").expect("write source");
        fs::write(fixture.path().join("to"), b"to").expect("write destination");
        let root = open_fixture(fixture.path());
        let error = rename_entry(&root, "from", "to", false).expect_err("must reject overwrite");
        assert!(error.reason.contains("[EEXIST]"), "{}", error.reason);
        assert_eq!(
            fs::read(fixture.path().join("from")).expect("source remains"),
            b"from"
        );
        assert_eq!(
            fs::read(fixture.path().join("to")).expect("destination remains"),
            b"to"
        );
    }

    #[cfg(unix)]
    fn with_synchronized_parent_swap(
        operation: &'static str,
        prepare: impl FnOnce(&Path, &Path),
        execute: impl FnOnce(&Dir),
        verify: impl FnOnce(&Path, &Path),
    ) {
        use std::os::unix::fs::symlink;

        let fixture = tempdir().expect("tempdir");
        let outside = tempdir().expect("outside tempdir");
        let gate = fixture.path().join("gate");
        let parked = fixture.path().join("parked");
        fs::create_dir(&gate).expect("create gate");
        prepare(&gate, outside.path());
        let root = open_fixture(fixture.path());
        let gate_for_hook = gate.clone();
        let parked_for_hook = parked.clone();
        let outside_for_hook = outside.path().to_owned();
        install_test_operation_hook(move |observed| {
            assert_eq!(observed, operation);
            fs::rename(&gate_for_hook, &parked_for_hook).expect("park opened component");
            symlink(&outside_for_hook, &gate_for_hook).expect("swap external symlink");
        });

        execute(&root);
        assert!(
            fs::symlink_metadata(&gate)
                .expect("gate metadata")
                .file_type()
                .is_symlink()
        );
        verify(&parked, outside.path());
    }

    #[cfg(unix)]
    #[test]
    fn retained_parent_capabilities_confine_every_operation_after_a_synchronized_swap() {
        with_synchronized_parent_swap(
            "lstat",
            |gate, outside| {
                fs::write(gate.join("item"), b"in").expect("inside item");
                fs::write(outside.join("item"), b"outside").expect("outside item");
            },
            |root| {
                let output = MetadataTask {
                    root: root.try_clone().expect("clone root"),
                    path: "gate/item".to_owned(),
                    follow: false,
                }
                .compute()
                .expect("lstat retained parent");
                assert_eq!(output.size, 2.0);
            },
            |_parked, outside| assert_eq!(fs::read(outside.join("item")).unwrap(), b"outside"),
        );
        with_synchronized_parent_swap(
            "metadata",
            |gate, outside| {
                fs::write(gate.join("item"), b"in").expect("inside item");
                fs::write(outside.join("item"), b"outside").expect("outside item");
            },
            |root| {
                let output = MetadataTask {
                    root: root.try_clone().expect("clone root"),
                    path: "gate/item".to_owned(),
                    follow: true,
                }
                .compute()
                .expect("metadata retained parent");
                assert_eq!(output.size, 2.0);
            },
            |_parked, outside| assert_eq!(fs::read(outside.join("item")).unwrap(), b"outside"),
        );
        with_synchronized_parent_swap(
            "readFile",
            |gate, outside| {
                fs::write(gate.join("item"), b"inside").expect("inside item");
                fs::write(outside.join("item"), b"outside").expect("outside item");
            },
            |root| {
                let output = ReadFileTask {
                    root: root.try_clone().expect("clone root"),
                    path: "gate/item".to_owned(),
                }
                .compute()
                .expect("read retained parent");
                assert_eq!(output, b"inside");
            },
            |_parked, outside| assert_eq!(fs::read(outside.join("item")).unwrap(), b"outside"),
        );
        with_synchronized_parent_swap(
            "readDirectory",
            |gate, outside| {
                fs::create_dir(gate.join("directory")).expect("inside directory");
                fs::write(gate.join("directory/inside"), b"inside").expect("inside entry");
                fs::create_dir(outside.join("directory")).expect("outside directory");
                fs::write(outside.join("directory/outside"), b"outside").expect("outside entry");
            },
            |root| {
                let output = ReadDirectoryTask {
                    root: root.try_clone().expect("clone root"),
                    path: "gate/directory".to_owned(),
                }
                .compute()
                .expect("read directory retained parent");
                assert_eq!(output.len(), 1);
                assert_eq!(output[0].name, "inside");
            },
            |_parked, outside| assert!(outside.join("directory/outside").exists()),
        );
        with_synchronized_parent_swap(
            "createFile",
            |_gate, _outside| {},
            |root| {
                CreateFileTask {
                    root: root.try_clone().expect("clone root"),
                    path: "gate/created".to_owned(),
                    data: b"inside".to_vec(),
                }
                .compute()
                .expect("create retained parent");
            },
            |parked, outside| {
                assert_eq!(fs::read(parked.join("created")).unwrap(), b"inside");
                assert!(!outside.join("created").exists());
            },
        );
        with_synchronized_parent_swap(
            "replaceFile",
            |gate, outside| {
                fs::write(gate.join("item"), b"inside before").expect("inside item");
                fs::write(outside.join("item"), b"outside").expect("outside item");
            },
            |root| {
                replace_file(root, "gate/item", b"inside after").expect("replace retained parent")
            },
            |parked, outside| {
                assert_eq!(fs::read(parked.join("item")).unwrap(), b"inside after");
                assert_eq!(fs::read(outside.join("item")).unwrap(), b"outside");
            },
        );
        with_synchronized_parent_swap(
            "rename",
            |gate, outside| {
                fs::write(gate.join("from"), b"inside").expect("inside source");
                fs::write(outside.join("from"), b"outside source").expect("outside source");
            },
            |root| {
                rename_entry(root, "gate/from", "gate/to", false).expect("rename retained parent")
            },
            |parked, outside| {
                assert_eq!(fs::read(parked.join("to")).unwrap(), b"inside");
                assert_eq!(fs::read(outside.join("from")).unwrap(), b"outside source");
                assert!(!outside.join("to").exists());
            },
        );
        with_synchronized_parent_swap(
            "remove",
            |gate, outside| {
                fs::write(gate.join("item"), b"inside").expect("inside item");
                fs::write(outside.join("item"), b"outside").expect("outside item");
            },
            |root| remove_entry(root, "gate/item", false).expect("remove retained parent"),
            |parked, outside| {
                assert!(!parked.join("item").exists());
                assert_eq!(fs::read(outside.join("item")).unwrap(), b"outside");
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn entry_removal_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;
        let fixture = tempdir().expect("tempdir");
        let outside = tempdir().expect("outside tempdir");
        fs::write(outside.path().join("keep"), b"outside").expect("outside file");
        symlink(outside.path(), fixture.path().join("link")).expect("create symlink");
        let root = open_fixture(fixture.path());
        remove_entry(&root, "link", true).expect("remove link");
        assert_eq!(
            fs::read(outside.path().join("keep")).expect("outside remains"),
            b"outside"
        );
    }
}
