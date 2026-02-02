//! Workflow learning - analyze recorded sessions to generate workflow skills

use super::RecordedSession;
use crate::types::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;

/// Workflow category
#[napi(string_enum)]
#[derive(Debug, PartialEq)]
pub enum WorkflowCategory {
    ApiPackage,  // Single domain, mostly API calls
    Workflow,    // Multi-domain or complex navigation
}

/// Analyze a recorded session and determine its category
#[napi]
pub fn workflow_categorize(session: RecordedSession) -> WorkflowCategory {
    let domain_count = session.domains.len();
    let api_calls = session.steps.iter().filter(|s| s.step_type == "api_call").count();
    let actions = session.steps.iter().filter(|s| s.step_type == "action").count();
    let navigations = session.steps.iter().filter(|s| s.step_type == "navigation").count();

    let total_steps = session.steps.len();
    if total_steps == 0 {
        return WorkflowCategory::Workflow;
    }

    let api_ratio = api_calls as f64 / total_steps as f64;

    // Single domain with mostly API calls = API package
    if domain_count == 1 && api_ratio > 0.7 {
        return WorkflowCategory::ApiPackage;
    }

    // Multiple domains = workflow
    if domain_count > 1 {
        return WorkflowCategory::Workflow;
    }

    // Many actions = workflow
    if actions > api_calls {
        return WorkflowCategory::Workflow;
    }

    // Many navigations = workflow
    if navigations > 3 {
        return WorkflowCategory::Workflow;
    }

    // Default to API package for single domain
    WorkflowCategory::ApiPackage
}

/// Learn a workflow skill from a recorded session
#[napi]
pub fn workflow_learn(session: RecordedSession) -> Result<WorkflowSkill> {
    let category = workflow_categorize(session.clone());

    match category {
        WorkflowCategory::ApiPackage => learn_api_package(session),
        WorkflowCategory::Workflow => learn_workflow(session),
    }
}

/// Learn an API package from a session
fn learn_api_package(session: RecordedSession) -> Result<WorkflowSkill> {
    let mut steps: Vec<WorkflowStep> = Vec::new();
    let mut seen_endpoints: std::collections::HashSet<String> = std::collections::HashSet::new();

    for step in &session.steps {
        if step.step_type == "api_call" {
            if let (Some(url), Some(method)) = (&step.url, &step.method) {
                let key = format!("{}:{}", method, url);
                if seen_endpoints.contains(&key) {
                    continue;
                }
                seen_endpoints.insert(key);

                steps.push(WorkflowStep {
                    id: uuid::Uuid::new_v4().to_string(),
                    step_type: "api_call".to_string(),
                    url: Some(url.clone()),
                    method: Some(method.clone()),
                    headers: None,
                    body: None,
                    action: None,
                    selector: None,
                    value: None,
                    extractions: None,
                    wait_for: None,
                    timeout_ms: Some(30000),
                });
            }
        }
    }

    let name = if !session.domains.is_empty() {
        format!("{}-api", session.domains[0].replace('.', "-"))
    } else {
        "unknown-api".to_string()
    };

    Ok(WorkflowSkill {
        id: session.id,
        name,
        description: Some(format!(
            "API package with {} endpoints",
            steps.len()
        )),
        steps,
        inputs: None,
        outputs: None,
    })
}

/// Learn a workflow from a session
fn learn_workflow(session: RecordedSession) -> Result<WorkflowSkill> {
    let mut steps: Vec<WorkflowStep> = Vec::new();

    for step in &session.steps {
        match step.step_type.as_str() {
            "navigation" => {
                if let Some(url) = &step.url {
                    steps.push(WorkflowStep {
                        id: uuid::Uuid::new_v4().to_string(),
                        step_type: "navigate".to_string(),
                        url: Some(url.clone()),
                        method: None,
                        headers: None,
                        body: None,
                        action: None,
                        selector: None,
                        value: None,
                        extractions: None,
                        wait_for: Some("load".to_string()),
                        timeout_ms: Some(30000),
                    });
                }
            }
            "action" => {
                if let Some(action) = &step.action {
                    steps.push(WorkflowStep {
                        id: uuid::Uuid::new_v4().to_string(),
                        step_type: "browser_action".to_string(),
                        url: None,
                        method: None,
                        headers: None,
                        body: None,
                        action: Some(action.clone()),
                        selector: step.selector.clone(),
                        value: step.value.clone(),
                        extractions: None,
                        wait_for: None,
                        timeout_ms: Some(10000),
                    });
                }
            }
            "api_call" => {
                if let (Some(url), Some(method)) = (&step.url, &step.method) {
                    steps.push(WorkflowStep {
                        id: uuid::Uuid::new_v4().to_string(),
                        step_type: "api_call".to_string(),
                        url: Some(url.clone()),
                        method: Some(method.clone()),
                        headers: None,
                        body: None,
                        action: None,
                        selector: None,
                        value: None,
                        extractions: None,
                        wait_for: None,
                        timeout_ms: Some(30000),
                    });
                }
            }
            _ => {}
        }
    }

    let name = if session.domains.len() > 1 {
        format!(
            "{}-to-{}-workflow",
            session.domains[0].replace('.', "-"),
            session.domains.last().unwrap_or(&session.domains[0]).replace('.', "-")
        )
    } else if !session.domains.is_empty() {
        format!("{}-workflow", session.domains[0].replace('.', "-"))
    } else {
        "unknown-workflow".to_string()
    };

    Ok(WorkflowSkill {
        id: session.id,
        name,
        description: Some(format!(
            "Workflow across {} domains with {} steps",
            session.domains.len(),
            steps.len()
        )),
        steps,
        inputs: None,
        outputs: None,
    })
}

/// Extract variable extractions from API responses
#[napi]
pub fn workflow_extract_variables(
    response_body: String,
    patterns: Vec<String>,
) -> HashMap<String, String> {
    let mut variables: HashMap<String, String> = HashMap::new();

    // Try to parse as JSON
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&response_body) {
        for pattern in &patterns {
            // Simple dot-notation path extraction
            let parts: Vec<&str> = pattern.split('.').collect();
            let mut current = &json;

            for part in &parts {
                if let Some(idx) = part.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                    if let Ok(i) = idx.parse::<usize>() {
                        if let Some(arr) = current.as_array() {
                            if let Some(v) = arr.get(i) {
                                current = v;
                                continue;
                            }
                        }
                    }
                }
                if let Some(v) = current.get(*part) {
                    current = v;
                } else {
                    break;
                }
            }

            if let Some(s) = current.as_str() {
                variables.insert(pattern.clone(), s.to_string());
            } else if let Some(n) = current.as_i64() {
                variables.insert(pattern.clone(), n.to_string());
            } else if let Some(b) = current.as_bool() {
                variables.insert(pattern.clone(), b.to_string());
            }
        }
    }

    variables
}
