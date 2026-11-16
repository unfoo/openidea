//! Live updates of explicitly selected JDT build descriptors.
use super::*;
use ide_language::LanguageServerConfig;
use std::collections::BTreeSet;

fn descriptors(config: &LanguageServerConfig) -> Option<Vec<String>> {
    let Some(value) = config.initialization_options.as_ref().and_then(|v| v.get("projectConfigurations")) else {
        return Some(Vec::new());
    };
    value.as_array()?.iter().map(|v| v.as_str().map(str::to_owned)).collect()
}

pub(crate) fn changes(current: &LanguageServerConfig, next: &LanguageServerConfig) -> Option<Value> {
    if current.name != SERVER {
        return None;
    }
    let before = descriptors(current)?;
    let after = descriptors(next)?;
    if before == after {
        return None;
    }
    let before: BTreeSet<_> = before.into_iter().collect();
    let after: BTreeSet<_> = after.into_iter().collect();
    let strip = |c: &LanguageServerConfig| {
        let mut c = c.clone();
        c.settings = None;
        if let Some(toml::Value::Table(options)) = &mut c.initialization_options {
            options.remove("projectConfigurations");
        }
        c
    };
    if strip(current) != strip(next) {
        return None;
    }
    let folders = |items: Vec<&String>| -> Option<Vec<String>> {
        items
            .into_iter()
            .map(|uri| {
                let path = crate::uri::uri_to_path(uri)?;
                let folder = path.parent()?;
                let folder = dunce::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
                Some(crate::uri::path_to_uri_string(&folder))
            })
            .collect()
    };
    let added: Vec<_> = after.difference(&before).collect();
    let updated = folders(after.intersection(&before).collect())?;
    let removed = folders(before.difference(&after).collect())?;
    Some(json!([added, updated, removed]))
}

pub(crate) async fn apply(run: &Running, arguments: Value) -> IdeResult<()> {
    let folders = |values: &Value, descriptors: bool| -> Vec<PathBuf> {
        values
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(crate::uri::uri_to_path)
            .filter_map(|path| if descriptors { path.parent().map(Path::to_path_buf) } else { Some(path) })
            .map(|path| dunce::canonicalize(&path).unwrap_or(path))
            .collect()
    };
    let added = folders(&arguments[0], true);
    let removed = folders(&arguments[2], false);
    let update = async {
        run.peer
            .request::<_, Value>(
                "workspace/executeCommand",
                json!({"command": "java.project.changeImportedProjects", "arguments": arguments}),
                None,
            )
            .await?;
        // JDT schedules import asynchronously. Retiring a just-added project before
        // it exists would otherwise miss it and leave a stale project registered.
        if added.is_empty() && removed.is_empty() {
            return Ok(());
        }
        loop {
            let projects = run
                .peer
                .request::<_, Value>(
                    "workspace/executeCommand",
                    json!({"command": "java.project.getAll", "arguments": []}),
                    None,
                )
                .await?;
            let current = folders(&projects, false);
            if added.iter().all(|p| current.contains(p))
                && removed.iter().filter(|p| !added.contains(p)).all(|p| !current.contains(p))
            {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    tokio::time::timeout(COMMAND_TIMEOUT, update)
        .await
        .unwrap_or(Err(ide_jsonrpc::RpcError::Timeout))
        .map_err(|e| crate::rpc_err(SERVER, "java.project.changeImportedProjects", e))
}

impl LspManager {
    /// Reloads externally written server settings and refreshes selected JDT projects in place.
    pub async fn refresh_java_project_configs(&self, path: &Path) -> IdeResult<()> {
        self.reconfigure().await;
        let Some(server) = self.servers_for(&LanguageId::new("java"), path).into_iter().find(|s| s.name == SERVER)
        else {
            return Ok(());
        };
        let Some(run) = server.running() else {
            return Ok(());
        };
        let uris = descriptors(&server.effective_config()).unwrap_or_default();
        if !uris.is_empty() {
            let identifiers: Vec<_> = uris.iter().map(|uri| json!({"uri": uri})).collect();
            run.peer
                .notify("java/projectConfigurationsUpdate", json!({"identifiers": identifiers}))
                .map_err(|e| crate::rpc_err(SERVER, "java/projectConfigurationsUpdate", e))?;
        }
        Ok(())
    }
}
