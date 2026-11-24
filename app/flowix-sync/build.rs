fn main() {
    println!("cargo:rerun-if-env-changed=FLOWIX_CLOUD_ENVIRONMENT");
    println!("cargo:rerun-if-env-changed=FLOWIX_DEV_MODE");

    let is_dev_build = matches!(std::env::var("FLOWIX_DEV_MODE").as_deref(), Ok("1"));
    let configured_environment =
        std::env::var("FLOWIX_CLOUD_ENVIRONMENT").unwrap_or_else(|_| "prod".to_owned());
    let environment = if is_dev_build {
        configured_environment.as_str()
    } else {
        "prod"
    };
    match environment {
        "staging" | "cn-staging" | "prod" => (),
        other => {
            panic!("FLOWIX_CLOUD_ENVIRONMENT must be staging, cn-staging, or prod, got {other:?}")
        }
    }
    println!("cargo:rustc-env=FLOWIX_CLOUD_ENVIRONMENT={environment}");
}
