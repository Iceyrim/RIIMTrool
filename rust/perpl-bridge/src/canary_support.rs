use std::path::PathBuf;

use alloy::signers::local::PrivateKeySigner;

use crate::tx;

/// Reads a signer only when a gated wallet worker invokes the factory. Construction alone never
/// touches the path, which keeps argument validation and disabled gates secret-independent.
pub struct FileSignerFactory {
    pub key_file: PathBuf,
}

impl tx::SignerFactory for FileSignerFactory {
    type Signer = PrivateKeySigner;

    fn initialize(self) -> Result<Self::Signer, String> {
        let contents = std::fs::read_to_string(&self.key_file).map_err(|_| {
            format!(
                "unable to read --signer-key-file: {}",
                self.key_file.display()
            )
        })?;
        contents
            .trim()
            .parse::<PrivateKeySigner>()
            .map_err(|_| "signer key file does not contain a valid private key".to_string())
    }
}
