/// Cloud target used by the desktop application.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudEnvironment {
    Staging,
    MainlandStaging,
    Prod,
}

impl CloudEnvironment {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Staging => "staging",
            Self::MainlandStaging => "cn-staging",
            Self::Prod => "prod",
        }
    }

    pub const fn api_base(self) -> &'static str {
        match self {
            Self::Staging => "https://staging-cloud.flowix.cc",
            Self::MainlandStaging => "https://staging-cloud.flowix.cc",
            Self::Prod => "https://cloud.flowix.cc",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "staging" => Some(Self::Staging),
            "cn-staging" => Some(Self::MainlandStaging),
            "prod" => Some(Self::Prod),
            _ => None,
        }
    }

    /// The development staging target follows the persisted application region.
    /// An explicitly selected production target stays production.
    pub fn for_dev_region(self, region: &str) -> Self {
        match (self, region) {
            (Self::Staging | Self::MainlandStaging, "mainland") => Self::MainlandStaging,
            (Self::Staging | Self::MainlandStaging, "overseas") => Self::Staging,
            _ => self,
        }
    }
}

pub fn default_cloud_environment() -> CloudEnvironment {
    CloudEnvironment::parse(env!("FLOWIX_CLOUD_ENVIRONMENT")).unwrap_or(CloudEnvironment::Prod)
}

#[cfg(test)]
mod tests {
    use super::CloudEnvironment;

    #[test]
    fn mainland_staging_uses_cloudflare_staging_target() {
        let environment = CloudEnvironment::parse("cn-staging").unwrap();
        assert_eq!(environment.name(), "cn-staging");
        assert_eq!(environment.api_base(), "https://staging-cloud.flowix.cc");
        assert_ne!(environment.api_base(), CloudEnvironment::Prod.api_base());
    }

    #[test]
    fn development_staging_follows_region_without_switching_production() {
        assert_eq!(
            CloudEnvironment::Staging.for_dev_region("mainland"),
            CloudEnvironment::MainlandStaging
        );
        assert_eq!(
            CloudEnvironment::MainlandStaging.for_dev_region("overseas"),
            CloudEnvironment::Staging
        );
        assert_eq!(
            CloudEnvironment::Prod.for_dev_region("mainland"),
            CloudEnvironment::Prod
        );
        assert_eq!(
            CloudEnvironment::Staging.for_dev_region(""),
            CloudEnvironment::Staging
        );
    }
}
