use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

fn collect_rust_sources(directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).expect("read workspace-fs source directory") {
        let path = entry.expect("read workspace-fs source entry").path();
        if path.is_dir() {
            collect_rust_sources(&path, files);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
}

fn main() {
    napi_build::setup();

    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let mut files = [
        "Cargo.lock",
        "Cargo.toml",
        "build.rs",
        "deny.toml",
        "rust-toolchain.toml",
    ]
    .into_iter()
    .map(|name| root.join(name))
    .collect::<Vec<_>>();
    collect_rust_sources(&root.join("src"), &mut files);
    files.sort();

    let mut digest = Sha256::new();
    for path in files {
        let relative = path.strip_prefix(&root).expect("source below crate root");
        let relative = relative.to_string_lossy().replace('\\', "/");
        let bytes =
            fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        digest.update((relative.len() as u64).to_be_bytes());
        digest.update(relative.as_bytes());
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes);
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let fingerprint = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    println!("cargo:rustc-env=VOLT_WORKSPACE_FS_SOURCE_FINGERPRINT={fingerprint}");
}
