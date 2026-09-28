use schemars::JsonSchema;
use serde::Deserialize;
use std::env;
use zed::settings::ContextServerSettings;
use zed_extension_api::{
    self as zed, serde_json, Command, ContextServerConfiguration, ContextServerId, Project, Result,
};

const PACKAGE_NAME: &str = "unbrowse";
/// Pinned so an update is a reviewed extension release, not a silent npm change.
const PACKAGE_VERSION: &str = "12.1.1";
const SERVER_PATH: &str = "node_modules/unbrowse/dist/cli.js";
const CONTEXT_SERVER_ID: &str = "mcp-server-unbrowse";

struct UnbrowseModelContextExtension;

#[derive(Debug, Deserialize, JsonSchema)]
struct UnbrowseContextServerSettings {
    /// Unbrowse API key (starts with `ub_live_`). Create one at https://unbrowse.ai/app
    unbrowse_api_key: String,
}

impl zed::Extension for UnbrowseModelContextExtension {
    fn new() -> Self {
        Self
    }

    fn context_server_command(
        &mut self,
        _context_server_id: &ContextServerId,
        project: &Project,
    ) -> Result<Command> {
        let settings = ContextServerSettings::for_project(CONTEXT_SERVER_ID, project)?;
        let Some(settings) = settings.settings else {
            return Err(
                "missing `unbrowse_api_key` setting; create a key at https://unbrowse.ai/app"
                    .into(),
            );
        };
        let settings: UnbrowseContextServerSettings =
            serde_json::from_value(settings).map_err(|e| e.to_string())?;
        let api_key = settings.unbrowse_api_key.trim().to_string();
        if api_key.is_empty() || api_key == "YOUR_API_KEY" {
            return Err(
                "set `unbrowse_api_key` to your Unbrowse API key from https://unbrowse.ai/app"
                    .into(),
            );
        }

        let installed_version = zed::npm_package_installed_version(PACKAGE_NAME)?;
        if installed_version.as_deref() != Some(PACKAGE_VERSION) {
            zed::npm_install_package(PACKAGE_NAME, PACKAGE_VERSION)?;
        }

        let server_path = env::current_dir()
            .map_err(|e| e.to_string())?
            .join(SERVER_PATH)
            .to_string_lossy()
            .to_string();

        Ok(Command {
            command: zed::node_binary_path()?,
            args: vec![server_path, "mcp".into()],
            env: vec![("UNBROWSE_API_KEY".into(), api_key)],
        })
    }

    fn context_server_configuration(
        &mut self,
        _context_server_id: &ContextServerId,
        _project: &Project,
    ) -> Result<Option<ContextServerConfiguration>> {
        let installation_instructions =
            include_str!("../configuration/installation_instructions.md").to_string();
        let default_settings = include_str!("../configuration/default_settings.jsonc").to_string();
        let settings_schema =
            serde_json::to_string(&schemars::schema_for!(UnbrowseContextServerSettings))
                .map_err(|e| e.to_string())?;

        Ok(Some(ContextServerConfiguration {
            installation_instructions,
            default_settings,
            settings_schema,
        }))
    }
}

zed::register_extension!(UnbrowseModelContextExtension);
