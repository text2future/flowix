use super::*;

const DEV_CLOUD_ENVIRONMENT_FILE_NAME: &str = "dev-cloud-environment.json";
const CLOUD_STORAGE_FILE_NAME: &str = "cloud-storage.json";
const CLOUD_DEV_STAGING_SECRET_PROVIDER: &str = "flowix_cloud_dev_staging_refresh";
const CLOUD_DEV_MAINLAND_STAGING_SECRET_PROVIDER: &str =
    "flowix_cloud_dev_mainland_staging_refresh";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevCloudEnvironment {
    Staging,
    MainlandStaging,
}

impl DevCloudEnvironment {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "staging" => Some(Self::Staging),
            "cn-staging" => Some(Self::MainlandStaging),
            _ => None,
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::Staging => "staging",
            Self::MainlandStaging => "cn-staging",
        }
    }

    pub fn for_region(self, region: &str) -> Self {
        match (self, region) {
            (Self::Staging | Self::MainlandStaging, "mainland") => Self::MainlandStaging,
            (Self::Staging | Self::MainlandStaging, "overseas") => Self::Staging,
            _ => self,
        }
    }
}

impl TryFrom<flowix_sync::CloudEnvironment> for DevCloudEnvironment {
    type Error = ();

    fn try_from(environment: flowix_sync::CloudEnvironment) -> Result<Self, Self::Error> {
        match environment {
            flowix_sync::CloudEnvironment::Staging => Ok(Self::Staging),
            flowix_sync::CloudEnvironment::MainlandStaging => Ok(Self::MainlandStaging),
            flowix_sync::CloudEnvironment::Prod => Err(()),
        }
    }
}

impl From<DevCloudEnvironment> for flowix_sync::CloudEnvironment {
    fn from(environment: DevCloudEnvironment) -> Self {
        match environment {
            DevCloudEnvironment::Staging => Self::Staging,
            DevCloudEnvironment::MainlandStaging => Self::MainlandStaging,
        }
    }
}

/// The persisted storage selection is independent from Cloud account login.
/// Keeping the target kind on disk lets startup fail closed when a selected
/// custom profile's secret cannot be read from the system secret store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CloudStorageTarget {
    Official,
    CustomS3 { profile_id: String },
}

impl Default for CloudStorageTarget {
    fn default() -> Self {
        Self::Official
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStorageProfile {
    pub id: String,
    pub remote: flowix_sync::remote::S3Remote,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStorageSettings {
    #[serde(default)]
    pub active_target: CloudStorageTarget,
    #[serde(default)]
    pub profiles: Vec<CloudStorageProfile>,
}

impl UserConfigStore {
    /// Dev Cloud selection has its own file so changing the dev endpoint never
    /// changes the production app's shared preference.json.
    pub fn get_dev_cloud_environment(&self) -> Option<DevCloudEnvironment> {
        let path = dev_cloud_environment_file_path(&self.config_dir);
        let bytes = fs::read(path).ok()?;
        let environment = match serde_json::from_slice::<String>(&bytes) {
            Ok(environment) => environment,
            Err(error) => {
                tracing::warn!(%error, "dev Cloud environment preference is invalid");
                return None;
            }
        };
        if environment == "prod" {
            return None;
        }
        let parsed = DevCloudEnvironment::parse(&environment);
        if parsed.is_none() {
            tracing::warn!(%environment, "ignoring unsupported Dev Cloud environment");
        }
        parsed
    }

    pub fn set_dev_cloud_environment(
        &self,
        environment: DevCloudEnvironment,
    ) -> Result<(), UserConfigError> {
        let content = serde_json::to_string(environment.name())?;
        atomic_write_json(&dev_cloud_environment_file_path(&self.config_dir), &content)?;
        Ok(())
    }

    /// Persists the entire S3 profile as one secret-store entry so the profile
    /// and its credentials cannot become mismatched after a partial write.
    pub fn save_custom_s3_remote(
        &self,
        remote: &flowix_sync::remote::S3Remote,
        access_key_id: &str,
        secret_access_key: &str,
    ) -> Result<(), UserConfigError> {
        remote
            .open(access_key_id, secret_access_key)
            .map_err(|error| UserConfigError::InvalidConfig(error.to_string()))?;
        let value = serde_json::to_string(&(remote, access_key_id, secret_access_key))?;
        self.save_provider_secret("cloud_custom_s3", &value)
    }

    /// Reads a saved profile without exposing its keys through desktop IPC.
    pub fn load_custom_s3_remote(
        &self,
    ) -> Result<Option<flowix_sync::ObjectStoreCredentials>, UserConfigError> {
        let account = entry_name("cloud_custom_s3", SECRET_ACCOUNT_NAME);
        let value = self
            .secrets
            .load(&account)
            .map_err(|error| UserConfigError::SecretStore(error.to_string()))?;
        let Some(value) = value else { return Ok(None) };
        let (remote, access, secret): (flowix_sync::remote::S3Remote, String, String) =
            serde_json::from_str(value.expose())?;
        remote
            .open(&access, &secret)
            .map(Some)
            .map_err(|error| UserConfigError::InvalidConfig(error.to_string()))
    }

    pub fn delete_custom_s3_remote(&self) -> Result<(), UserConfigError> {
        self.delete_provider_secret("cloud_custom_s3")
    }

    /// Returns non-secret storage configuration for Preferences and bootstrap.
    /// A missing configuration file triggers a one-time migration of the old
    /// single `cloud_custom_s3` secret, if present.
    pub fn get_cloud_storage_settings(&self) -> Result<CloudStorageSettings, UserConfigError> {
        let _guard = self
            .cloud_storage_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.load_cloud_storage_settings_unlocked()
    }

    /// Upserts an S3 profile. Credentials are kept in the SecretStore, while
    /// endpoint, bucket, and prefix remain inspectable local configuration.
    /// Blank credentials on an existing profile keep its keys.
    pub fn save_custom_s3_profile(
        &self,
        profile: CloudStorageProfile,
        access_key_id: &str,
        secret_access_key: &str,
    ) -> Result<CloudStorageSettings, UserConfigError> {
        validate_cloud_profile_id(&profile.id)?;
        let _guard = self
            .cloud_storage_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut settings = self.load_cloud_storage_settings_unlocked()?;

        let (access_key_id, secret_access_key) =
            if access_key_id.trim().is_empty() && secret_access_key.is_empty() {
                let Some((saved_remote, access, secret)) =
                    self.load_custom_s3_profile_secret(&profile.id)?
                else {
                    return Err(UserConfigError::InvalidConfig(
                        "credentials are required for a new S3 profile".into(),
                    ));
                };
                if !same_s3_remote(&saved_remote, &profile.remote) {
                    return Err(UserConfigError::InvalidConfig(
                        "re-enter S3 credentials after changing endpoint or storage scope".into(),
                    ));
                }
                (access, secret)
            } else if access_key_id.trim().is_empty() || secret_access_key.is_empty() {
                return Err(UserConfigError::InvalidConfig(
                    "both S3 credentials must be provided together".into(),
                ));
            } else {
                (access_key_id.to_string(), secret_access_key.to_string())
            };

        profile
            .remote
            .open(&access_key_id, &secret_access_key)
            .map_err(|error| UserConfigError::InvalidConfig(error.to_string()))?;
        self.save_custom_s3_profile_secret(
            &profile.id,
            &profile.remote,
            &access_key_id,
            &secret_access_key,
        )?;

        if let Some(existing) = settings
            .profiles
            .iter_mut()
            .find(|item| item.id == profile.id)
        {
            *existing = profile.clone();
        } else {
            settings.profiles.push(profile.clone());
        }
        self.persist_cloud_storage_settings(&settings)?;
        Ok(settings)
    }

    /// Changes the persisted startup target. The running manager remains bound
    /// to its current target until the next application start.
    pub fn select_cloud_storage_target(
        &self,
        target: CloudStorageTarget,
    ) -> Result<CloudStorageSettings, UserConfigError> {
        let _guard = self
            .cloud_storage_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut settings = self.load_cloud_storage_settings_unlocked()?;
        if let CloudStorageTarget::CustomS3 { profile_id } = &target {
            if !settings
                .profiles
                .iter()
                .any(|profile| profile.id == *profile_id)
            {
                return Err(UserConfigError::InvalidConfig(
                    "selected S3 profile does not exist".into(),
                ));
            }
        }
        settings.active_target = target;
        self.persist_cloud_storage_settings(&settings)?;
        Ok(settings)
    }

    /// Removes profile metadata first. If its local secret cannot be deleted,
    /// it is left orphaned in the local S3 credential database.
    pub fn delete_custom_s3_profile(
        &self,
        profile_id: &str,
    ) -> Result<CloudStorageSettings, UserConfigError> {
        validate_cloud_profile_id(profile_id)?;
        let _guard = self
            .cloud_storage_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut settings = self.load_cloud_storage_settings_unlocked()?;
        let previous_count = settings.profiles.len();
        settings.profiles.retain(|profile| profile.id != profile_id);
        if settings.profiles.len() == previous_count {
            return Err(UserConfigError::InvalidConfig(
                "S3 profile does not exist".into(),
            ));
        }
        if matches!(&settings.active_target, CloudStorageTarget::CustomS3 { profile_id: active } if active == profile_id)
        {
            settings.active_target = CloudStorageTarget::Official;
        }
        self.persist_cloud_storage_settings(&settings)?;
        self.delete_custom_s3_profile_secret(profile_id)?;
        Ok(settings)
    }

    /// Loads credentials for a saved profile without exposing them through
    /// IPC. `None` means the metadata exists but its secret is missing.
    pub fn load_custom_s3_profile_credentials(
        &self,
        profile_id: &str,
    ) -> Result<Option<flowix_sync::ObjectStoreCredentials>, UserConfigError> {
        validate_cloud_profile_id(profile_id)?;
        let _guard = self
            .cloud_storage_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let settings = self.load_cloud_storage_settings_unlocked()?;
        let Some(profile) = settings
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
        else {
            return Ok(None);
        };
        let Some((remote, access, secret)) = self.load_custom_s3_profile_secret(profile_id)? else {
            return Ok(None);
        };
        if !same_s3_remote(&remote, &profile.remote) {
            return Err(UserConfigError::InvalidConfig(
                "S3 profile metadata does not match its stored credentials".into(),
            ));
        }
        remote
            .open(&access, &secret)
            .map(Some)
            .map_err(|error| UserConfigError::InvalidConfig(error.to_string()))
    }

    fn load_cloud_storage_settings_unlocked(
        &self,
    ) -> Result<CloudStorageSettings, UserConfigError> {
        let path = self.config_dir.join(CLOUD_STORAGE_FILE_NAME);
        match fs::read(&path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.migrate_legacy_custom_s3_unlocked()
            }
            Err(error) => Err(error.into()),
        }
    }

    fn migrate_legacy_custom_s3_unlocked(&self) -> Result<CloudStorageSettings, UserConfigError> {
        let legacy_account = entry_name("cloud_custom_s3", SECRET_ACCOUNT_NAME);
        let legacy = self
            .secrets
            .load(&legacy_account)
            .map_err(|error| UserConfigError::SecretStore(error.to_string()))?;
        let Some(legacy) = legacy else {
            return Ok(CloudStorageSettings::default());
        };
        let (remote, access, secret): (flowix_sync::remote::S3Remote, String, String) =
            serde_json::from_str(legacy.expose())?;
        remote
            .open(&access, &secret)
            .map_err(|error| UserConfigError::InvalidConfig(error.to_string()))?;
        let profile = CloudStorageProfile {
            id: "legacy-default".into(),
            remote: remote.clone(),
        };
        self.save_custom_s3_profile_secret(&profile.id, &remote, &access, &secret)?;
        let settings = CloudStorageSettings {
            active_target: CloudStorageTarget::CustomS3 {
                profile_id: profile.id.clone(),
            },
            profiles: vec![profile],
        };
        self.persist_cloud_storage_settings(&settings)?;
        if let Err(error) = self.delete_provider_secret("cloud_custom_s3") {
            tracing::warn!(%error, "legacy S3 secret migrated but could not be removed");
        }
        Ok(settings)
    }

    fn persist_cloud_storage_settings(
        &self,
        settings: &CloudStorageSettings,
    ) -> Result<(), UserConfigError> {
        let content = serde_json::to_string_pretty(settings)?;
        atomic_write_json(&self.config_dir.join(CLOUD_STORAGE_FILE_NAME), &content)?;
        Ok(())
    }

    fn save_custom_s3_profile_secret(
        &self,
        profile_id: &str,
        remote: &flowix_sync::remote::S3Remote,
        access_key_id: &str,
        secret_access_key: &str,
    ) -> Result<(), UserConfigError> {
        let value = serde_json::to_string(&(remote, access_key_id, secret_access_key))?;
        let provider = custom_s3_profile_secret_provider(profile_id);
        let account = entry_name(&provider, SECRET_ACCOUNT_NAME);
        self.custom_s3_secret_store()
            .save(&account, &value)
            .map_err(|error| UserConfigError::SecretStore(error.to_string()))?;
        if let Err(error) = self.secrets.delete(&account) {
            tracing::warn!(%error, %profile_id, "failed to remove S3 credentials from the legacy secret backend");
        }
        Ok(())
    }

    fn load_custom_s3_profile_secret(
        &self,
        profile_id: &str,
    ) -> Result<Option<(flowix_sync::remote::S3Remote, String, String)>, UserConfigError> {
        let provider = custom_s3_profile_secret_provider(profile_id);
        let account = entry_name(&provider, SECRET_ACCOUNT_NAME);
        let local_secrets = self.custom_s3_secret_store();
        let value = local_secrets
            .load(&account)
            .map_err(|error| UserConfigError::SecretStore(error.to_string()))?;
        if let Some(value) = value {
            if let Err(error) = self.secrets.delete(&account) {
                tracing::warn!(%error, %profile_id, "failed to remove duplicate S3 credentials from the legacy secret backend");
            }
            return serde_json::from_str(value.expose())
                .map(Some)
                .map_err(UserConfigError::from);
        }

        let Some(legacy_value) = self
            .secrets
            .load(&account)
            .map_err(|error| UserConfigError::SecretStore(error.to_string()))?
        else {
            return Ok(None);
        };
        let credentials = serde_json::from_str(legacy_value.expose())?;
        local_secrets
            .save(&account, legacy_value.expose())
            .map_err(|error| UserConfigError::SecretStore(error.to_string()))?;
        if let Err(error) = self.secrets.delete(&account) {
            tracing::warn!(%error, %profile_id, "failed to remove migrated S3 credentials from the legacy secret backend");
        }
        Ok(Some(credentials))
    }

    fn delete_custom_s3_profile_secret(&self, profile_id: &str) -> Result<(), UserConfigError> {
        let provider = custom_s3_profile_secret_provider(profile_id);
        let account = entry_name(&provider, SECRET_ACCOUNT_NAME);
        self.custom_s3_secret_store()
            .delete(&account)
            .map_err(|error| UserConfigError::SecretStore(error.to_string()))?;
        self.secrets
            .delete(&account)
            .map(|_| ())
            .map_err(|error| UserConfigError::SecretStore(error.to_string()))
    }

    fn custom_s3_secret_store(&self) -> SecretStore {
        SecretStore::new_shared_database(self.config_dir.join("db").join("local.db"))
    }

    fn cloud_dev_secret_provider(environment: DevCloudEnvironment) -> &'static str {
        match environment {
            DevCloudEnvironment::Staging => CLOUD_DEV_STAGING_SECRET_PROVIDER,
            DevCloudEnvironment::MainlandStaging => CLOUD_DEV_MAINLAND_STAGING_SECRET_PROVIDER,
        }
    }

    pub fn save_cloud_dev_refresh_token(
        &self,
        environment: DevCloudEnvironment,
        token: &str,
    ) -> Result<(), UserConfigError> {
        self.save_provider_secret(Self::cloud_dev_secret_provider(environment), token)
    }

    pub fn load_cloud_dev_refresh_token(
        &self,
        environment: DevCloudEnvironment,
    ) -> Result<Option<String>, UserConfigError> {
        let provider = Self::cloud_dev_secret_provider(environment);
        let account = entry_name(provider, SECRET_ACCOUNT_NAME);
        self.secrets
            .load(&account)
            .map(|value| value.map(|secret| secret.into_inner()))
            .map_err(|err| UserConfigError::SecretStore(err.to_string()))
    }

    pub fn delete_cloud_dev_refresh_token(
        &self,
        environment: DevCloudEnvironment,
    ) -> Result<(), UserConfigError> {
        self.delete_provider_secret(Self::cloud_dev_secret_provider(environment))
    }
}

fn custom_s3_profile_secret_provider(profile_id: &str) -> String {
    format!("cloud_custom_s3_profile_{profile_id}")
}

fn validate_cloud_profile_id(profile_id: &str) -> Result<(), UserConfigError> {
    if profile_id.is_empty()
        || profile_id.len() > 80
        || !profile_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(UserConfigError::InvalidConfig(
            "invalid S3 profile id".into(),
        ));
    }
    Ok(())
}

fn same_s3_remote(
    left: &flowix_sync::remote::S3Remote,
    right: &flowix_sync::remote::S3Remote,
) -> bool {
    left.endpoint == right.endpoint
        && left.region == right.region
        && left.bucket == right.bucket
        && left.prefix == right.prefix
}

fn dev_cloud_environment_file_path(config_dir: &Path) -> PathBuf {
    config_dir
        .join(BOOT_DIR_NAME)
        .join(DEV_CLOUD_ENVIRONMENT_FILE_NAME)
}
