use crate::business_graph::GraphScopeKind;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const PACKAGE_TOTAL_LIMIT: usize = 512 * 1024;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentFrontmatter {
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    preset: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    interactive: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct SkillFrontmatter {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPackageDescriptor {
    pub name: String,
    pub title: String,
    pub description: String,
    pub scope: GraphScopeKind,
    pub path: String,
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadowed_by: Option<GraphScopeKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRequest {
    pub name: String,
    pub workspace: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub preset: Option<String>,
    #[serde(default)]
    pub interactive: bool,
    #[serde(default)]
    pub follow: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRunPlan {
    pub name: String,
    pub title: String,
    pub preset: Option<String>,
    pub args: Vec<String>,
    pub prompt: String,
    pub interactive: bool,
    pub package_path: PathBuf,
    pub workspace: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeInventoryEntry {
    pub scope: GraphScopeKind,
    pub root: String,
    pub mounted: bool,
    pub components: Vec<String>,
}

#[derive(Debug, Clone)]
struct ScopeRoot {
    kind: GraphScopeKind,
    root: PathBuf,
}

pub fn list(home_path: &Path, workspace: &Path) -> Result<Vec<AgentPackageDescriptor>, String> {
    let roots = scope_roots(home_path, workspace)?;
    let mut seen = HashSet::new();
    let mut seen_roots = HashSet::new();
    let mut winner_scope = std::collections::HashMap::new();
    let mut packages = Vec::new();
    for root in roots {
        let root_identity = fs::canonicalize(&root.root).unwrap_or_else(|_| root.root.clone());
        if !seen_roots.insert(root_identity) {
            continue;
        }
        let directory = root.root.join("agents");
        let mut entries = match fs::read_dir(&directory) {
            Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not read '{}': {error}", directory.display())),
        };
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || !entry.path().is_dir() {
                continue;
            }
            let parsed = if valid_package_name(&name) {
                read_agent_package(&entry.path()).map(|(frontmatter, _)| frontmatter)
            } else {
                Err("Agent folder name must be 1-64 lowercase letters, numbers, and single hyphens."
                    .into())
            };
            let frontmatter = match parsed {
                Ok(frontmatter) => frontmatter,
                Err(diagnostic) => {
                    packages.push(AgentPackageDescriptor {
                        title: humanize(&name),
                        description: String::new(),
                        name,
                        scope: root.kind,
                        path: entry.path().to_string_lossy().into_owned(),
                        active: false,
                        shadowed_by: None,
                        diagnostic: Some(diagnostic),
                    });
                    continue;
                }
            };
            let active = seen.insert(name.clone());
            let shadowed_by = if active {
                winner_scope.insert(name.clone(), root.kind);
                None
            } else {
                winner_scope.get(&name).copied()
            };
            packages.push(AgentPackageDescriptor {
                title: nonempty(frontmatter.title, humanize(&name)),
                description: frontmatter.description.trim().to_string(),
                name,
                scope: root.kind,
                path: entry.path().to_string_lossy().into_owned(),
                active,
                shadowed_by,
                diagnostic: None,
            });
        }
    }
    packages.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(scope_rank(left.scope).cmp(&scope_rank(right.scope)))
    });
    Ok(packages)
}

pub fn resolve(home_path: &Path, request: &AgentRunRequest) -> Result<AgentRunPlan, String> {
    let name = request.name.trim();
    if !valid_package_name(name) {
        return Err(
            "Agent name must be 1-64 lowercase letters, numbers, and single hyphens.".into(),
        );
    }
    if request.args.iter().any(|argument| argument.contains('\0')) {
        return Err("Agent arguments must not contain NUL bytes.".into());
    }
    let workspace = canonical_directory(Path::new(&request.workspace), "agent working directory")?;
    let roots = scope_roots(home_path, &workspace)?;
    let mut invalid = Vec::new();
    let mut selected = None;
    for root in &roots {
        let package_path = root.root.join("agents").join(name);
        if !package_path.is_dir() {
            continue;
        }
        match read_agent_package(&package_path) {
            Ok((frontmatter, mission)) => {
                selected = Some((package_path, frontmatter, mission));
                break;
            }
            Err(diagnostic) => invalid.push(diagnostic),
        }
    }
    let (package_path, frontmatter, mission) = selected.ok_or_else(|| {
        if invalid.is_empty() {
            format!("Agent package '{name}' was not found in Project, Private, or Team.")
        } else {
            format!(
                "Agent package '{name}' has no valid visible copy:\n- {}",
                invalid.join("\n- ")
            )
        }
    })?;
    let interactive = frontmatter.interactive || request.interactive;
    if request.follow && interactive {
        return Err(
            "--follow supports headless agent runs only. Start the interactive run without --follow, then continue it in Mimir."
                .into(),
        );
    }
    let mut included_bytes = mission.len();
    if included_bytes > PACKAGE_TOTAL_LIMIT {
        return Err(format!(
            "Agent package '{name}' exceeds the {} KB prompt payload limit.",
            PACKAGE_TOTAL_LIMIT / 1024
        ));
    }
    let expanded = expand_files(&mission, &package_path, home_path, &mut included_bytes)?;
    let mut prompt = expanded.trim().to_string();
    for skill_name in &frontmatter.skills {
        let (skill_path, content) = resolve_skill(&roots, skill_name)?;
        included_bytes = included_bytes.saturating_add(content.len());
        if included_bytes > PACKAGE_TOTAL_LIMIT {
            return Err(format!(
                "Agent package '{name}' includes more than {} KB of files and skills.",
                PACKAGE_TOTAL_LIMIT / 1024
            ));
        }
        prompt.push_str(&format!(
            "\n\n---\nSkill: {}\nPath: {}\n\n{}",
            skill_name,
            skill_path.display(),
            content.trim_end()
        ));
    }
    prompt.push_str(&format!(
        "\n\n---\nAgent package: {}",
        package_path.display()
    ));
    let mut args = frontmatter.args;
    args.extend(request.args.clone());
    if args.iter().any(|argument| argument.contains('\0')) {
        return Err(format!(
            "Agent package '{name}' contains a NUL byte in args."
        ));
    }
    let title = nonempty(frontmatter.title, humanize(name));
    let preset = request
        .preset
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let value = frontmatter.preset.trim();
            (!value.is_empty()).then(|| value.to_string())
        });
    Ok(AgentRunPlan {
        name: name.to_string(),
        title,
        preset,
        args,
        prompt,
        interactive,
        package_path,
        workspace,
    })
}

pub fn inventory(home_path: &Path, workspace: &Path) -> Result<Vec<ScopeInventoryEntry>, String> {
    let roots = scope_roots(home_path, workspace)?;
    let mut entries = Vec::new();
    for kind in [
        GraphScopeKind::Private,
        GraphScopeKind::Project,
        GraphScopeKind::Team,
    ] {
        let root = roots.iter().find(|root| root.kind == kind);
        let Some(root) = root else {
            if kind == GraphScopeKind::Team {
                continue;
            }
            entries.push(ScopeInventoryEntry {
                scope: kind,
                root: String::new(),
                mounted: false,
                components: Vec::new(),
            });
            continue;
        };
        let mut components = Vec::new();
        if root.root.join("graph").is_dir() {
            components.push("graph".into());
        }
        if root.root.join("resources").is_dir() {
            components.push("resources".into());
        }
        if root.root.join("skills").is_dir() {
            components.push("skills".into());
        }
        if root.root.join("agents").is_dir() {
            components.push("agents".into());
        }
        entries.push(ScopeInventoryEntry {
            scope: kind,
            root: root.root.to_string_lossy().into_owned(),
            mounted: true,
            components,
        });
    }
    Ok(entries)
}

fn parse_agent_source(raw: &str, path: &Path) -> Result<(AgentFrontmatter, String), String> {
    let without_bom = raw.strip_prefix("\u{feff}").unwrap_or(raw);
    let normalized = if without_bom.contains("\r\n") {
        Cow::Owned(without_bom.replace("\r\n", "\n"))
    } else {
        Cow::Borrowed(without_bom)
    };
    if !normalized.starts_with("---\n") {
        return Ok((AgentFrontmatter::default(), normalized.into_owned()));
    }
    let end = normalized[4..]
        .find("\n---\n")
        .map(|offset| offset + 4)
        .ok_or_else(|| format!("AGENT.md frontmatter is not closed: {}", path.display()))?;
    let frontmatter =
        serde_yaml::from_str::<AgentFrontmatter>(&normalized[4..end]).map_err(|error| {
            format!(
                "Invalid AGENT.md frontmatter in '{}': {error}",
                path.display()
            )
        })?;
    Ok((frontmatter, normalized[end + 5..].to_string()))
}

fn read_agent_package(package_path: &Path) -> Result<(AgentFrontmatter, String), String> {
    let source_path = package_path.join("AGENT.md");
    let raw = read_utf8_bounded(&source_path, PACKAGE_TOTAL_LIMIT)?.ok_or_else(|| {
        format!(
            "AGENT.md exceeds the {} KB prompt payload limit: {}",
            PACKAGE_TOTAL_LIMIT / 1024,
            source_path.display()
        )
    })?;
    let (frontmatter, mission) = parse_agent_source(&raw, &source_path)?;
    if mission.trim().is_empty() {
        return Err(format!(
            "AGENT.md mission must not be empty: {}",
            source_path.display()
        ));
    }
    Ok((frontmatter, mission))
}

fn expand_files(
    mission: &str,
    package_path: &Path,
    home_path: &Path,
    total: &mut usize,
) -> Result<String, String> {
    let matcher = Regex::new(r"(?m)(^|[ \t])@([^\s]+)").expect("agent include regex is valid");
    let mut output = String::with_capacity(mission.len());
    let mut cursor = 0;
    for captures in matcher.captures_iter(mission) {
        let whole = captures.get(0).expect("include match exists");
        let prefix = captures.get(1).map(|value| value.as_str()).unwrap_or("");
        let token = captures.get(2).expect("include path exists").as_str();
        output.push_str(&mission[cursor..whole.start()]);
        output.push_str(prefix);
        let requested = if token == "~" {
            home_path.to_path_buf()
        } else if let Some(relative) = token.strip_prefix("~/") {
            home_path.join(relative)
        } else if Path::new(token).is_absolute() {
            PathBuf::from(token)
        } else {
            package_path.join(token)
        };
        let remaining = PACKAGE_TOTAL_LIMIT.saturating_sub(*total);
        let Some(bytes) = read_bytes_bounded(&requested, remaining)? else {
            return Err(format!(
                "Agent package exceeds the {} KB prompt payload limit at '{}'.",
                PACKAGE_TOTAL_LIMIT / 1024,
                requested.display()
            ));
        };
        *total = total.saturating_add(bytes.len());
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| format!("Included file '{}' is not UTF-8 text.", requested.display()))?;
        if text.contains('\0') {
            return Err(format!(
                "Included file '{}' contains a NUL byte.",
                requested.display()
            ));
        }
        output.push_str(text);
        cursor = whole.end();
    }
    output.push_str(&mission[cursor..]);
    Ok(output)
}

fn resolve_skill(roots: &[ScopeRoot], name: &str) -> Result<(PathBuf, String), String> {
    if !valid_package_name(name) {
        return Err(format!("Agent names invalid skill '{name}'."));
    }
    let mut invalid = Vec::new();
    for candidate in roots.iter().map(|root| root.root.join("skills").join(name)) {
        let source = candidate.join("SKILL.md");
        if source.is_file() {
            let content = match read_utf8_bounded(&source, PACKAGE_TOTAL_LIMIT) {
                Ok(Some(content)) => content,
                Ok(None) => {
                    invalid.push(format!(
                        "'{}' exceeds {} KB",
                        source.display(),
                        PACKAGE_TOTAL_LIMIT / 1024
                    ));
                    continue;
                }
                Err(error) => {
                    invalid.push(error);
                    continue;
                }
            };
            match validate_skill_source(&content, &source, name) {
                Ok(()) => return Ok((candidate, content)),
                Err(error) => invalid.push(error),
            }
        }
    }
    if !invalid.is_empty() {
        return Err(format!(
            "Agent requires skill '{name}', but no valid visible copy exists:\n- {}",
            invalid.join("\n- ")
        ));
    }
    Err(format!(
        "Agent requires skill '{name}', but it is not visible in Project, Private, or Team."
    ))
}

fn validate_skill_source(content: &str, source: &Path, expected_name: &str) -> Result<(), String> {
    let without_bom = content.strip_prefix("\u{feff}").unwrap_or(content);
    let normalized = if without_bom.contains("\r\n") {
        Cow::Owned(without_bom.replace("\r\n", "\n"))
    } else {
        Cow::Borrowed(without_bom)
    };
    if !normalized.starts_with("---\n") {
        return Err(format!(
            "SKILL.md must start with YAML frontmatter: {}",
            source.display()
        ));
    }
    let end = normalized[4..]
        .find("\n---\n")
        .map(|offset| offset + 4)
        .ok_or_else(|| format!("SKILL.md frontmatter is not closed: {}", source.display()))?;
    let frontmatter =
        serde_yaml::from_str::<SkillFrontmatter>(&normalized[4..end]).map_err(|error| {
            format!(
                "Invalid SKILL.md frontmatter in '{}': {error}",
                source.display()
            )
        })?;
    if frontmatter.name.trim() != expected_name {
        return Err(format!(
            "SKILL.md name must match folder '{expected_name}': {}",
            source.display()
        ));
    }
    let description = frontmatter.description.trim();
    if description.is_empty() || description.len() > 1024 {
        return Err(format!(
            "SKILL.md description must contain 1-1024 characters: {}",
            source.display()
        ));
    }
    Ok(())
}

fn read_utf8_bounded(path: &Path, limit: usize) -> Result<Option<String>, String> {
    let Some(bytes) = read_bytes_bounded(path, limit)? else {
        return Ok(None);
    };
    let text = String::from_utf8(bytes)
        .map_err(|_| format!("File '{}' is not UTF-8 text.", path.display()))?;
    if text.contains('\0') {
        return Err(format!("File '{}' contains a NUL byte.", path.display()));
    }
    Ok(Some(text))
}

fn read_bytes_bounded(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not read '{}': {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("File '{}' is not a regular file.", path.display()));
    }
    if metadata.len() > limit as u64 {
        return Ok(None);
    }
    let file = fs::File::open(path)
        .map_err(|error| format!("Could not read '{}': {error}", path.display()))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read '{}': {error}", path.display()))?;
    Ok((bytes.len() <= limit).then_some(bytes))
}

fn scope_roots(home_path: &Path, workspace: &Path) -> Result<Vec<ScopeRoot>, String> {
    let mimir_home = home_path.join(".mimir");
    let project = project_root(workspace);
    let mut roots = vec![
        ScopeRoot {
            kind: GraphScopeKind::Project,
            root: project,
        },
        ScopeRoot {
            kind: GraphScopeKind::Private,
            root: mimir_home.join("private"),
        },
    ];
    if let Some(team) = configured_team_path(&mimir_home)? {
        if team.is_dir() {
            roots.push(ScopeRoot {
                kind: GraphScopeKind::Team,
                root: fs::canonicalize(team)
                    .map_err(|error| format!("Could not resolve Team folder: {error}"))?,
            });
        }
    }
    Ok(roots)
}

fn project_root(workspace: &Path) -> PathBuf {
    git2::Repository::discover(workspace)
        .ok()
        .and_then(|repository| repository.workdir().map(Path::to_path_buf))
        .and_then(|root| fs::canonicalize(root).ok())
        .unwrap_or_else(|| workspace.to_path_buf())
}

fn configured_team_path(mimir_home: &Path) -> Result<Option<PathBuf>, String> {
    let managed = mimir_home.join("team-graph");
    Ok(crate::managed_git::is_valid_team_repository(&managed).then_some(managed))
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Could not resolve {label} '{}': {error}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "{label} is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

fn valid_package_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

fn humanize(value: &str) -> String {
    value
        .split('-')
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn nonempty(value: String, fallback: String) -> String {
    let value = value.trim();
    if value.is_empty() {
        fallback
    } else {
        value.to_string()
    }
}

fn scope_rank(scope: GraphScopeKind) -> u8 {
    match scope {
        GraphScopeKind::Project => 0,
        GraphScopeKind::Private => 1,
        GraphScopeKind::Team => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install_team_contract(home: &Path) -> PathBuf {
        let team = home.join(".mimir/team-graph");
        fs::create_dir_all(team.join("graph")).unwrap();
        fs::create_dir_all(team.join("resources")).unwrap();
        fs::write(
            team.join("mimir-team.toml"),
            "version = 1\nname = \"Test Team\"\n",
        )
        .unwrap();
        let repo = git2::Repository::init(&team).unwrap();
        repo.remote("origin", "https://github.com/example/test-team-graph.git")
            .unwrap();
        team
    }

    fn request(name: &str, workspace: &Path) -> AgentRunRequest {
        AgentRunRequest {
            name: name.into(),
            workspace: workspace.to_string_lossy().into_owned(),
            args: Vec::new(),
            preset: None,
            interactive: false,
            follow: false,
        }
    }

    #[test]
    fn resolves_project_agent_splices_and_skills() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("agents/evidence")).unwrap();
        fs::create_dir_all(workspace.path().join("skills/search")).unwrap();
        fs::write(
            workspace.path().join("agents/evidence/checklist.md"),
            "Check one.\n",
        )
        .unwrap();
        fs::write(
            workspace.path().join("agents/evidence/AGENT.md"),
            "---\ntitle: Evidence sweep\nargs: [--model, opus]\nskills: [search]\n---\nDo the work.\n@checklist.md\n",
        ).unwrap();
        fs::write(
            workspace.path().join("skills/search/SKILL.md"),
            "---\nname: search\ndescription: Search precisely.\n---\nSearch precisely.\n",
        )
        .unwrap();

        let plan = resolve(
            home.path(),
            &AgentRunRequest {
                name: "evidence".into(),
                workspace: workspace.path().to_string_lossy().into_owned(),
                args: vec!["--verbose".into()],
                preset: Some("claude".into()),
                interactive: true,
                follow: false,
            },
        )
        .unwrap();

        assert_eq!(plan.title, "Evidence sweep");
        assert_eq!(plan.preset.as_deref(), Some("claude"));
        assert_eq!(plan.args, ["--model", "opus", "--verbose"]);
        assert!(plan.interactive);
        assert!(plan.prompt.contains("Check one."));
        assert!(plan.prompt.contains("Skill: search"));
        assert!(plan.prompt.contains("Search precisely."));
    }

    #[test]
    fn invalid_project_skill_does_not_hide_valid_private_skill() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("agents/evidence")).unwrap();
        fs::create_dir_all(workspace.path().join("skills/search")).unwrap();
        fs::create_dir_all(home.path().join(".mimir/private/skills/search")).unwrap();
        fs::write(
            workspace.path().join("agents/evidence/AGENT.md"),
            "---\nskills: [search]\n---\nUse the search skill.\n",
        )
        .unwrap();
        fs::write(
            workspace.path().join("skills/search/SKILL.md"),
            "---\nname: wrong\ndescription: Broken override.\n---\nBroken.\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".mimir/private/skills/search/SKILL.md"),
            "---\nname: search\ndescription: Private search.\n---\nPrivate search instructions.\n",
        )
        .unwrap();

        let plan = resolve(home.path(), &request("evidence", workspace.path())).unwrap();

        assert!(plan.prompt.contains("Private search instructions."));
        assert!(plan.prompt.contains(".mimir/private/skills/search"));
        assert!(!plan.prompt.contains("Broken override."));
    }

    #[test]
    fn project_package_shadows_private_and_team() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let team = install_team_contract(home.path());
        fs::create_dir_all(home.path().join(".mimir/private/agents/review")).unwrap();
        fs::create_dir_all(workspace.path().join("agents/review")).unwrap();
        fs::create_dir_all(team.join("agents/review")).unwrap();
        for (path, mission) in [
            (workspace.path().join("agents/review/AGENT.md"), "Project"),
            (
                home.path().join(".mimir/private/agents/review/AGENT.md"),
                "Private",
            ),
            (team.join("agents/review/AGENT.md"), "Team"),
        ] {
            fs::write(path, mission).unwrap();
        }

        let packages = list(home.path(), workspace.path()).unwrap();
        assert_eq!(packages.len(), 3);
        assert_eq!(packages.iter().filter(|package| package.active).count(), 1);
        assert_eq!(
            packages
                .iter()
                .find(|package| package.active)
                .unwrap()
                .scope,
            GraphScopeKind::Project
        );
    }

    #[test]
    fn inventory_omits_team_until_the_fixed_repository_is_valid() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let missing_team = home.path().join("missing-team");
        fs::create_dir_all(home.path().join(".mimir/private/graph")).unwrap();
        fs::create_dir_all(home.path().join(".mimir/private/skills/example")).unwrap();
        fs::create_dir_all(workspace.path().join("graph")).unwrap();
        fs::write(
            home.path().join(".mimir/settings.json"),
            serde_json::to_vec(&serde_json::json!({
                "editor": { "mimirTeamFolder": missing_team }
            }))
            .unwrap(),
        )
        .unwrap();

        let entries = inventory(home.path(), workspace.path()).unwrap();
        let private = entries
            .iter()
            .find(|entry| entry.scope == GraphScopeKind::Private)
            .unwrap();
        let project = entries
            .iter()
            .find(|entry| entry.scope == GraphScopeKind::Project)
            .unwrap();
        assert_eq!(private.components, ["graph", "skills"]);
        assert_eq!(project.components, ["graph"]);
        assert!(entries
            .iter()
            .all(|entry| entry.scope != GraphScopeKind::Team));
    }

    #[test]
    fn invalid_project_package_does_not_hide_valid_private_package() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("agents/review")).unwrap();
        fs::create_dir_all(home.path().join(".mimir/private/agents/review")).unwrap();
        fs::write(
            workspace.path().join("agents/review/AGENT.md"),
            "---\ntitle: Broken\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".mimir/private/agents/review/AGENT.md"),
            "Review the work.\n",
        )
        .unwrap();

        let packages = list(home.path(), workspace.path()).unwrap();
        let project = packages
            .iter()
            .find(|package| package.scope == GraphScopeKind::Project)
            .unwrap();
        let private = packages
            .iter()
            .find(|package| package.scope == GraphScopeKind::Private)
            .unwrap();

        assert!(!project.active);
        assert!(project.diagnostic.is_some());
        assert!(private.active);

        let plan = resolve(home.path(), &request("review", workspace.path())).unwrap();
        assert_eq!(
            plan.package_path,
            home.path().join(".mimir/private/agents/review")
        );
        assert!(plan.prompt.starts_with("Review the work."));
    }

    #[test]
    fn follow_rejects_an_interactive_package_before_launch() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("agents/live")).unwrap();
        fs::write(
            workspace.path().join("agents/live/AGENT.md"),
            "---\ninteractive: true\n---\nTalk with the user.\n",
        )
        .unwrap();

        let error = resolve(
            home.path(),
            &AgentRunRequest {
                name: "live".into(),
                workspace: workspace.path().to_string_lossy().into_owned(),
                args: Vec::new(),
                preset: None,
                interactive: false,
                follow: true,
            },
        )
        .unwrap_err();

        assert!(error.contains("headless agent runs only"));
    }

    #[test]
    fn list_reports_missing_sources_and_bad_names_without_hiding_valid_packages() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("agents/empty")).unwrap();
        fs::create_dir_all(workspace.path().join("agents/Bad_Name")).unwrap();
        fs::write(
            workspace.path().join("agents/Bad_Name/AGENT.md"),
            "Mission.\n",
        )
        .unwrap();
        fs::create_dir_all(home.path().join(".mimir/private/agents/review")).unwrap();
        fs::write(
            home.path().join(".mimir/private/agents/review/AGENT.md"),
            "Review the work.\n",
        )
        .unwrap();

        let packages = list(home.path(), workspace.path()).unwrap();

        assert!(packages
            .iter()
            .any(|package| package.name == "review" && package.active));
        assert!(packages.iter().any(|package| {
            package.name == "empty"
                && !package.active
                && package
                    .diagnostic
                    .as_deref()
                    .is_some_and(|diagnostic| diagnostic.contains("AGENT.md"))
        }));
        assert!(packages.iter().any(|package| {
            package.name == "Bad_Name"
                && !package.active
                && package
                    .diagnostic
                    .as_deref()
                    .is_some_and(|diagnostic| diagnostic.contains("lowercase letters"))
        }));
    }

    #[test]
    fn missing_team_directory_does_not_block_project_resolution() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let missing_team = home.path().join("offline-team");
        fs::create_dir_all(home.path().join(".mimir")).unwrap();
        fs::write(
            home.path().join(".mimir/settings.json"),
            serde_json::to_vec(&serde_json::json!({
                "editor": { "mimirTeamFolder": missing_team }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::create_dir_all(workspace.path().join("agents/review")).unwrap();
        fs::write(
            workspace.path().join("agents/review/AGENT.md"),
            "Review the work.\n",
        )
        .unwrap();

        let plan = resolve(home.path(), &request("review", workspace.path())).unwrap();

        assert_eq!(plan.name, "review");
        assert_eq!(
            plan.package_path,
            fs::canonicalize(workspace.path())
                .unwrap()
                .join("agents/review")
        );
        assert!(!missing_team.exists());
    }

    #[test]
    fn legacy_setting_cannot_mount_the_project_as_team() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".mimir")).unwrap();
        fs::write(
            home.path().join(".mimir/settings.json"),
            serde_json::to_vec(&serde_json::json!({
                "editor": { "mimirTeamFolder": workspace.path() }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::create_dir_all(workspace.path().join("agents/review")).unwrap();
        fs::write(
            workspace.path().join("agents/review/AGENT.md"),
            "Review the work.\n",
        )
        .unwrap();

        let packages = list(home.path(), workspace.path()).unwrap();

        assert_eq!(packages.len(), 1);
        assert_eq!(packages[0].scope, GraphScopeKind::Project);
        assert!(packages[0].active);
    }

    #[test]
    fn parses_yaml_block_scalars_and_block_lists() {
        let source = Path::new("/tmp/AGENT.md");
        let (frontmatter, mission) = parse_agent_source(
            "---\ntitle: Evidence sweep\ndescription: >-\n  Review evidence\n  with care.\nargs:\n  - --model\n  - gpt-5\nskills: [search, graph]\ninteractive: true\n---\nDo the work.\n",
            source,
        )
        .unwrap();

        assert_eq!(frontmatter.title, "Evidence sweep");
        assert_eq!(frontmatter.description, "Review evidence with care.");
        assert_eq!(frontmatter.args, ["--model", "gpt-5"]);
        assert_eq!(frontmatter.skills, ["search", "graph"]);
        assert!(frontmatter.interactive);
        assert_eq!(mission, "Do the work.\n");
    }

    #[test]
    fn parses_crlf_agent_frontmatter_like_the_javascript_listing() {
        let source = Path::new("/tmp/AGENT.md");
        let (frontmatter, mission) = parse_agent_source(
            "---\r\ntitle: \"Review #1\"\r\n---\r\nReview the work.\r\n",
            source,
        )
        .unwrap();

        assert_eq!(frontmatter.title, "Review #1");
        assert_eq!(mission, "Review the work.\n");
    }

    #[test]
    fn rejects_invalid_names_and_missing_includes() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("agents/review")).unwrap();
        fs::write(
            workspace.path().join("agents/review/AGENT.md"),
            "Read @missing.txt before review.\n",
        )
        .unwrap();

        let bad_name = resolve(home.path(), &request("Bad_Name", workspace.path())).unwrap_err();
        let missing = resolve(home.path(), &request("review", workspace.path())).unwrap_err();

        assert!(bad_name.contains("lowercase letters"));
        assert!(missing.contains("missing.txt"));
    }

    #[test]
    fn missing_runtime_dependency_does_not_silently_switch_agent_missions() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("agents/review")).unwrap();
        fs::create_dir_all(home.path().join(".mimir/private/agents/review")).unwrap();
        fs::write(
            workspace.path().join("agents/review/AGENT.md"),
            "Review the project evidence in @missing.txt.\n",
        )
        .unwrap();
        fs::write(
            home.path().join(".mimir/private/agents/review/AGENT.md"),
            "Run the generic private review.\n",
        )
        .unwrap();

        let packages = list(home.path(), workspace.path()).unwrap();
        assert!(packages
            .iter()
            .any(|package| package.scope == GraphScopeKind::Project && package.active));
        let error = resolve(home.path(), &request("review", workspace.path())).unwrap_err();

        assert!(error.contains("missing.txt"));
        assert!(!error.contains("generic private review"));
    }

    #[test]
    fn enforces_one_total_prompt_payload_limit_regardless_of_file_count() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let package = workspace.path().join("agents/review");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("large.txt"), vec![b'x'; PACKAGE_TOTAL_LIMIT]).unwrap();
        fs::write(package.join("AGENT.md"), "@large.txt\n").unwrap();

        let one_file = resolve(home.path(), &request("review", workspace.path())).unwrap_err();
        assert!(one_file.contains("512 KB prompt payload limit"));

        for name in ["one.txt", "two.txt", "three.txt"] {
            fs::write(package.join(name), vec![b'x'; PACKAGE_TOTAL_LIMIT / 3]).unwrap();
        }
        fs::write(package.join("AGENT.md"), "@one.txt\n@two.txt\n@three.txt\n").unwrap();

        let many_files = resolve(home.path(), &request("review", workspace.path())).unwrap_err();
        assert!(many_files.contains("512 KB prompt payload limit"));
    }

    #[test]
    fn reports_an_oversized_agent_source_without_loading_it_as_active() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let package = workspace.path().join("agents/review");
        fs::create_dir_all(&package).unwrap();
        fs::write(
            package.join("AGENT.md"),
            vec![b'x'; PACKAGE_TOTAL_LIMIT + 1],
        )
        .unwrap();

        let packages = list(home.path(), workspace.path()).unwrap();

        assert_eq!(packages.len(), 1);
        assert!(!packages[0].active);
        assert!(packages[0]
            .diagnostic
            .as_deref()
            .is_some_and(|message| message.contains("512 KB prompt payload limit")));
    }
}
