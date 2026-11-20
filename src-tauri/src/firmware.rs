//! Independent firmware selections with shared snapshot and lifetime handling.
use crate::engine::{self, Operation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::PathBuf, sync::Arc};

pub const MAX_IMAGE: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FirmwarePurpose {
    Flash,
    Verify,
}

#[derive(Deserialize)]
pub struct ImportMetadata {
    pub purpose: FirmwarePurpose,
    pub name: String,
}

impl ImportMetadata {
    pub fn parse(header: &str) -> Result<Self, String> {
        if header.len() > 8192 {
            return Err("固件文件名过长".into());
        }
        serde_json::from_str(header).map_err(|_| "固件导入信息无效".into())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareInfo {
    pub id: String,
    pub name: String,
    pub size: usize,
    pub format: String,
    pub sha256: String,
}

pub struct Firmware {
    pub info: FirmwareInfo,
    pub path: PathBuf,
}

impl Firmware {
    pub fn snapshot(name: String, bytes: &[u8]) -> Result<Self, String> {
        if bytes.is_empty() || bytes.len() > MAX_IMAGE {
            return Err("固件须非空，且不超过 32 MiB".into());
        }
        let format = engine::image_type(&name)?;
        let info = FirmwareInfo {
            id: crate::id(),
            name,
            size: bytes.len(),
            format: format.into(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
        };
        // Only our generated basename reaches the filesystem. Each selection
        // owns an immutable snapshot, even when both source filenames match.
        let path = std::env::temp_dir().join(format!("flashstudio-{}.{}", info.id, format));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .map_err(|e| format!("无法缓存固件：{e}"))?;
        let written = file.write_all(bytes);
        drop(file);
        if let Err(error) = written {
            let _ = fs::remove_file(&path);
            return Err(error.to_string());
        }
        Ok(Self { info, path })
    }
}

impl Drop for Firmware {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[derive(Default)]
pub struct FirmwareFiles {
    flash: Option<Arc<Firmware>>,
    verify: Option<Arc<Firmware>>,
}

impl FirmwareFiles {
    #[cfg(test)]
    pub fn import(
        &mut self,
        purpose: FirmwarePurpose,
        name: String,
        bytes: &[u8],
    ) -> Result<FirmwareInfo, String> {
        Ok(self.insert(purpose, Firmware::snapshot(name, bytes)?))
    }

    pub fn insert(&mut self, purpose: FirmwarePurpose, firmware: Firmware) -> FirmwareInfo {
        let firmware = Arc::new(firmware);
        let info = firmware.info.clone();
        let slot = match purpose {
            FirmwarePurpose::Flash => &mut self.flash,
            FirmwarePurpose::Verify => &mut self.verify,
        };
        *slot = Some(firmware);
        info
    }

    pub fn select(
        &self,
        operation: Operation,
        id: Option<&str>,
    ) -> Result<Option<Arc<Firmware>>, String> {
        let firmware = match operation {
            Operation::Flash => self.flash.as_ref().ok_or("请先选择烧录固件")?,
            Operation::Verify => self.verify.as_ref().ok_or("请先选择校验参考固件")?,
            Operation::Probe | Operation::Erase => return Ok(None),
        };
        if id != Some(firmware.info.id.as_str()) {
            return Err("当前页面的固件已变更，请重新选择".into());
        }
        if !firmware.path.is_file() {
            return Err("固件缓存已丢失，请重新选择文件".into());
        }
        Ok(Some(firmware.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_metadata_preserves_unicode_and_spaces() {
        let metadata =
            ImportMetadata::parse(r#"{"purpose":"verify","name":"\u56fa\u4ef6 \ud83d\udd27.bin"}"#)
                .unwrap();
        assert!(matches!(metadata.purpose, FirmwarePurpose::Verify));
        assert_eq!(metadata.name, "固件 🔧.bin");
        for invalid in [
            "{}",
            r#"{"purpose":"erase","name":"a.bin"}"#,
            r#"{"purpose":"flash","name":null}"#,
            "not json",
        ] {
            assert!(ImportMetadata::parse(invalid).is_err());
        }
        assert!(ImportMetadata::parse(&" ".repeat(8193)).is_err());
    }

    #[test]
    fn maximum_size_snapshot_preserves_binary_and_cleans_up() {
        let bytes: Vec<u8> = (0..MAX_IMAGE).map(|i| (i % 251) as u8).collect();
        let firmware = Firmware::snapshot("完整出厂 固件.bin".into(), &bytes).unwrap();
        assert_eq!(firmware.info.size, MAX_IMAGE);
        assert_eq!(
            firmware.info.sha256,
            format!("{:x}", Sha256::digest(&bytes))
        );
        assert_eq!(fs::read(&firmware.path).unwrap(), bytes);
        let path = firmware.path.clone();
        drop(firmware);
        assert!(!path.exists());
        assert!(Firmware::snapshot("too-large.bin".into(), &vec![0; MAX_IMAGE + 1]).is_err());
    }

    #[test]
    fn selections_are_independent_and_reject_other_pages_file_ids() {
        let mut files = FirmwareFiles::default();
        let flash = files
            .import(FirmwarePurpose::Flash, "same.bin".into(), &[1, 2])
            .unwrap();
        assert!(files.select(Operation::Verify, Some(&flash.id)).is_err());
        let verify = files
            .import(FirmwarePurpose::Verify, "same.bin".into(), &[3, 4])
            .unwrap();
        let write_image = files
            .select(Operation::Flash, Some(&flash.id))
            .unwrap()
            .unwrap();
        let reference = files
            .select(Operation::Verify, Some(&verify.id))
            .unwrap()
            .unwrap();
        assert_ne!(write_image.path, reference.path);
        assert_eq!(fs::read(&write_image.path).unwrap(), [1, 2]);
        assert_eq!(fs::read(&reference.path).unwrap(), [3, 4]);
        assert!(files.select(Operation::Flash, Some(&verify.id)).is_err());
        assert!(files.select(Operation::Verify, Some(&flash.id)).is_err());
        assert!(files.select(Operation::Flash, None).is_err());
        assert!(
            files
                .select(Operation::Probe, Some(&flash.id))
                .unwrap()
                .is_none()
        );
        assert!(
            files
                .select(Operation::Erase, Some(&verify.id))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn replacing_a_selection_preserves_the_other_and_running_snapshot() {
        let mut files = FirmwareFiles::default();
        let flash = files
            .import(FirmwarePurpose::Flash, "factory.bin".into(), &[1])
            .unwrap();
        let verify = files
            .import(FirmwarePurpose::Verify, "app.bin".into(), &[2])
            .unwrap();
        let running = files
            .select(Operation::Flash, Some(&flash.id))
            .unwrap()
            .unwrap();
        let old_path = running.path.clone();
        assert!(
            files
                .import(FirmwarePurpose::Flash, "empty.bin".into(), &[])
                .is_err()
        );
        assert!(
            files
                .import(FirmwarePurpose::Verify, "bad.txt".into(), &[3])
                .is_err()
        );
        assert!(files.select(Operation::Flash, Some(&flash.id)).is_ok());
        let replacement = files
            .import(FirmwarePurpose::Flash, "new.bin".into(), &[4])
            .unwrap();
        assert!(files.select(Operation::Flash, Some(&flash.id)).is_err());
        assert_eq!(fs::read(&old_path).unwrap(), [1]);
        let new_path = files
            .select(Operation::Flash, Some(&replacement.id))
            .unwrap()
            .unwrap()
            .path
            .clone();
        let verify_path = files
            .select(Operation::Verify, Some(&verify.id))
            .unwrap()
            .unwrap()
            .path
            .clone();
        assert_eq!(fs::read(&verify_path).unwrap(), [2]);
        drop(running);
        assert!(!old_path.exists());
        drop(files);
        assert!(!new_path.exists());
        assert!(!verify_path.exists());
    }

    #[test]
    fn missing_snapshot_does_not_fall_back_to_another_file() {
        let mut files = FirmwareFiles::default();
        let flash = files
            .import(FirmwarePurpose::Flash, "factory.bin".into(), &[1])
            .unwrap();
        let verify = files
            .import(FirmwarePurpose::Verify, "app.bin".into(), &[2])
            .unwrap();
        let path = files
            .select(Operation::Verify, Some(&verify.id))
            .unwrap()
            .unwrap()
            .path
            .clone();
        fs::remove_file(path).unwrap();
        assert!(files.select(Operation::Verify, Some(&verify.id)).is_err());
        assert!(files.select(Operation::Flash, Some(&flash.id)).is_ok());
    }
}
