#[derive(Debug, thiserror::Error)]
pub enum AdeError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("tmux error: {0}")]
    Tmux(String),
    #[error("tmux not found")]
    TmuxMissing,
    #[error("tmux too old: {0}")]
    TmuxTooOld(String),
    #[error("pty error: {0}")]
    Pty(String),
    #[error("git error: {0}")]
    Git(#[from] git2::Error),
    #[error("github error: {0}")]
    GitHub(String),
    #[error("token invalid or missing")]
    TokenInvalid,
    #[error("rate limited until {0}")]
    RateLimited(String),
    #[error("keychain error: {0}")]
    Keychain(String),
    #[error("gestor provider unavailable: {0}")]
    ProviderMissing(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

impl AdeError {
    pub fn code(&self) -> &'static str {
        match self {
            AdeError::TmuxMissing => "TMUX_MISSING",
            AdeError::TmuxTooOld(_) => "TMUX_TOO_OLD",
            AdeError::TokenInvalid => "TOKEN_INVALID",
            AdeError::GitHub(s) if s.contains("scope") => "TOKEN_SCOPE",
            AdeError::RateLimited(_) => "RATE_LIMITED",
            AdeError::GitHub(_) => "SYNC_WRITE_FAILED",
            AdeError::Keychain(_) => "INTERNAL",
            AdeError::ProviderMissing(_) => "GESTOR_PROVIDER_MISSING",
            AdeError::Io(_) => "INTERNAL",
            AdeError::Other(_) => "INTERNAL",
            AdeError::Db(_) => "DB_ERROR",
            AdeError::Tmux(_) => "INTERNAL",
            AdeError::Pty(_) => "INTERNAL",
            AdeError::Git(_) => "INTERNAL",
        }
    }
}

impl serde::Serialize for AdeError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AdeError", 2)?;
        s.serialize_field("code", &self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_code_mapping() {
        assert_eq!(AdeError::TmuxMissing.code(), "TMUX_MISSING");
        assert_eq!(AdeError::TmuxTooOld("2.9".into()).code(), "TMUX_TOO_OLD");
        assert_eq!(AdeError::TokenInvalid.code(), "TOKEN_INVALID");
        assert_eq!(AdeError::RateLimited("12:00".into()).code(), "RATE_LIMITED");
        assert_eq!(AdeError::Db(sqlx::Error::RowNotFound).code(), "DB_ERROR");
        assert_eq!(AdeError::Other("oops".into()).code(), "INTERNAL");
    }

    #[test]
    fn error_serializes_to_json() {
        let err = AdeError::TokenInvalid;
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("TOKEN_INVALID"));
        assert!(json.contains("token invalid"));
    }
}
