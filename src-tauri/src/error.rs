#[derive(Debug, thiserror::Error)]
pub enum AdeError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for AdeError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AdeError", 2)?;
        s.serialize_field("code", &"INTERNAL")?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}
