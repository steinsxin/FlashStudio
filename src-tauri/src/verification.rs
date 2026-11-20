//! Verification milestones emitted by our Tcl command, independent of log text.
use serde::Serialize;

pub const COMPARING_MARKER: &str = "FLASHSTUDIO_VERIFY_COMPARING";
pub const MATCHED_MARKER: &str = "FLASHSTUDIO_VERIFY_MATCHED";

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VerificationStage {
    Connecting,
    Comparing,
    Matched,
}

impl VerificationStage {
    pub fn observe(&mut self, line: &str) {
        *self = match (*self, line.trim()) {
            (Self::Connecting, COMPARING_MARKER) => Self::Comparing,
            (Self::Comparing, MATCHED_MARKER) => Self::Matched,
            (stage, _) => stage,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ordered_exact_milestones_advance_verification() {
        let mut stage = VerificationStage::Connecting;
        for text in [
            "verified 1024 bytes",
            MATCHED_MARKER,
            "Error: FLASHSTUDIO_VERIFY_COMPARING",
        ] {
            stage.observe(text);
            assert_eq!(stage, VerificationStage::Connecting);
        }
        stage.observe(COMPARING_MARKER);
        assert_eq!(stage, VerificationStage::Comparing);
        stage.observe("verification failed");
        assert_eq!(stage, VerificationStage::Comparing);
        stage.observe(MATCHED_MARKER);
        assert_eq!(stage, VerificationStage::Matched);
        stage.observe(COMPARING_MARKER);
        assert_eq!(stage, VerificationStage::Matched);
    }
}
