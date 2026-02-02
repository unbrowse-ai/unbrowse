//! Workflow execution engine

use crate::types::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;

/// Execution result for a single step
#[napi(object)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StepResult {
    pub step_id: String,
    pub success: bool,
    pub latency_ms: i64,
    #[napi(ts_type = "number | undefined")]
    pub status: Option<i32>,
    #[napi(ts_type = "string | undefined")]
    pub response_body: Option<String>,
    #[napi(ts_type = "Record<string, string> | undefined")]
    pub extracted_variables: Option<HashMap<String, String>>,
    #[napi(ts_type = "string | undefined")]
    pub error: Option<String>,
}

/// Full workflow execution result
#[napi(object)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkflowResult {
    pub workflow_id: String,
    pub success: bool,
    pub total_latency_ms: i64,
    pub steps_completed: i32,
    pub steps_total: i32,
    pub step_results: Vec<StepResult>,
    pub final_variables: HashMap<String, String>,
    #[napi(ts_type = "string | undefined")]
    pub error: Option<String>,
}

/// Substitute variables in a string
fn substitute_variables(template: &str, variables: &HashMap<String, String>) -> String {
    let mut result = template.to_string();
    for (key, value) in variables {
        result = result.replace(&format!("${{{}}}", key), value);
        result = result.replace(&format!("${}", key), value);
    }
    result
}

/// Execute a single workflow step
async fn execute_step(
    step: &WorkflowStep,
    variables: &mut HashMap<String, String>,
    auth_headers: &HashMap<String, String>,
    cookies: &HashMap<String, String>,
    browser_port: Option<u32>,
) -> StepResult {
    let start = std::time::Instant::now();

    match step.step_type.as_str() {
        "api_call" => {
            execute_api_call(step, variables, auth_headers, cookies, start).await
        }
        "browser_action" => {
            execute_browser_action(step, variables, browser_port, start).await
        }
        "navigate" => {
            execute_navigate(step, variables, browser_port, start).await
        }
        "wait" => {
            execute_wait(step, start).await
        }
        "extract" => {
            execute_extract(step, variables, start)
        }
        _ => StepResult {
            step_id: step.id.clone(),
            success: false,
            latency_ms: start.elapsed().as_millis() as i64,
            status: None,
            response_body: None,
            extracted_variables: None,
            error: Some(format!("Unknown step type: {}", step.step_type)),
        },
    }
}

async fn execute_api_call(
    step: &WorkflowStep,
    variables: &mut HashMap<String, String>,
    auth_headers: &HashMap<String, String>,
    cookies: &HashMap<String, String>,
    start: std::time::Instant,
) -> StepResult {
    let url = match &step.url {
        Some(u) => substitute_variables(u, variables),
        None => {
            return StepResult {
                step_id: step.id.clone(),
                success: false,
                latency_ms: start.elapsed().as_millis() as i64,
                status: None,
                response_body: None,
                extracted_variables: None,
                error: Some("No URL specified".to_string()),
            }
        }
    };

    let method = step.method.as_deref().unwrap_or("GET");
    let timeout = std::time::Duration::from_millis(step.timeout_ms.unwrap_or(30000) as u64);

    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(c) => c,
        Err(e) => {
            return StepResult {
                step_id: step.id.clone(),
                success: false,
                latency_ms: start.elapsed().as_millis() as i64,
                status: None,
                response_body: None,
                extracted_variables: None,
                error: Some(format!("Failed to create client: {}", e)),
            }
        }
    };

    let mut req = match method {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "PATCH" => client.patch(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };

    // Add auth headers
    for (key, value) in auth_headers {
        req = req.header(key, substitute_variables(value, variables));
    }

    // Add step-specific headers
    if let Some(headers) = &step.headers {
        for (key, value) in headers {
            req = req.header(key, substitute_variables(value, variables));
        }
    }

    // Add cookies
    if !cookies.is_empty() {
        let cookie_str: String = cookies
            .iter()
            .map(|(k, v)| format!("{}={}", k, substitute_variables(v, variables)))
            .collect::<Vec<_>>()
            .join("; ");
        req = req.header("Cookie", cookie_str);
    }

    // Add body
    if let Some(body) = &step.body {
        let body = substitute_variables(body, variables);
        req = req.body(body);
    }

    match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16() as i32;
            let success = status >= 200 && status < 400;
            let body = resp.text().await.unwrap_or_default();

            // Extract variables if configured
            let extracted = if let Some(extractions) = &step.extractions {
                let mut vars: HashMap<String, String> = HashMap::new();
                for ext in extractions {
                    if let Some(json_path) = &ext.json_path {
                        let paths = vec![json_path.clone()];
                        let extracted = super::workflow_extract_variables(body.clone(), paths);
                        if let Some(value) = extracted.get(json_path) {
                            vars.insert(ext.name.clone(), value.clone());
                            variables.insert(ext.name.clone(), value.clone());
                        }
                    }
                }
                if vars.is_empty() { None } else { Some(vars) }
            } else {
                None
            };

            StepResult {
                step_id: step.id.clone(),
                success,
                latency_ms: start.elapsed().as_millis() as i64,
                status: Some(status),
                response_body: Some(body),
                extracted_variables: extracted,
                error: if success { None } else { Some(format!("HTTP {}", status)) },
            }
        }
        Err(e) => StepResult {
            step_id: step.id.clone(),
            success: false,
            latency_ms: start.elapsed().as_millis() as i64,
            status: None,
            response_body: None,
            extracted_variables: None,
            error: Some(e.to_string()),
        },
    }
}

async fn execute_browser_action(
    step: &WorkflowStep,
    variables: &HashMap<String, String>,
    browser_port: Option<u32>,
    start: std::time::Instant,
) -> StepResult {
    let action = match &step.action {
        Some(a) => a.clone(),
        None => {
            return StepResult {
                step_id: step.id.clone(),
                success: false,
                latency_ms: start.elapsed().as_millis() as i64,
                status: None,
                response_body: None,
                extracted_variables: None,
                error: Some("No action specified".to_string()),
            }
        }
    };

    // Parse element index from selector
    let element_index = step.selector.as_ref().and_then(|s| s.parse::<i32>().ok());
    let text = step.value.as_ref().map(|v| substitute_variables(v, variables));

    match crate::browser::browser_act(action.clone(), element_index, text, browser_port).await {
        Ok(success) => StepResult {
            step_id: step.id.clone(),
            success,
            latency_ms: start.elapsed().as_millis() as i64,
            status: None,
            response_body: None,
            extracted_variables: None,
            error: if success { None } else { Some("Action failed".to_string()) },
        },
        Err(e) => StepResult {
            step_id: step.id.clone(),
            success: false,
            latency_ms: start.elapsed().as_millis() as i64,
            status: None,
            response_body: None,
            extracted_variables: None,
            error: Some(e.to_string()),
        },
    }
}

async fn execute_navigate(
    step: &WorkflowStep,
    variables: &HashMap<String, String>,
    browser_port: Option<u32>,
    start: std::time::Instant,
) -> StepResult {
    let url = match &step.url {
        Some(u) => substitute_variables(u, variables),
        None => {
            return StepResult {
                step_id: step.id.clone(),
                success: false,
                latency_ms: start.elapsed().as_millis() as i64,
                status: None,
                response_body: None,
                extracted_variables: None,
                error: Some("No URL specified".to_string()),
            }
        }
    };

    match crate::browser::browser_navigate(url, browser_port).await {
        Ok(success) => StepResult {
            step_id: step.id.clone(),
            success,
            latency_ms: start.elapsed().as_millis() as i64,
            status: None,
            response_body: None,
            extracted_variables: None,
            error: if success { None } else { Some("Navigation failed".to_string()) },
        },
        Err(e) => StepResult {
            step_id: step.id.clone(),
            success: false,
            latency_ms: start.elapsed().as_millis() as i64,
            status: None,
            response_body: None,
            extracted_variables: None,
            error: Some(e.to_string()),
        },
    }
}

async fn execute_wait(step: &WorkflowStep, start: std::time::Instant) -> StepResult {
    let duration = std::time::Duration::from_millis(step.timeout_ms.unwrap_or(1000) as u64);
    tokio::time::sleep(duration).await;

    StepResult {
        step_id: step.id.clone(),
        success: true,
        latency_ms: start.elapsed().as_millis() as i64,
        status: None,
        response_body: None,
        extracted_variables: None,
        error: None,
    }
}

fn execute_extract(
    step: &WorkflowStep,
    variables: &mut HashMap<String, String>,
    start: std::time::Instant,
) -> StepResult {
    // Extract from variables using configured extractions
    let mut extracted: HashMap<String, String> = HashMap::new();

    if let Some(extractions) = &step.extractions {
        for ext in extractions {
            if let Some(regex_pattern) = &ext.regex {
                // Apply regex to source variable
                if let Some(source_value) = variables.get(&ext.source) {
                    if let Ok(re) = regex::Regex::new(regex_pattern) {
                        if let Some(caps) = re.captures(source_value) {
                            if let Some(m) = caps.get(1) {
                                extracted.insert(ext.name.clone(), m.as_str().to_string());
                                variables.insert(ext.name.clone(), m.as_str().to_string());
                            } else if let Some(m) = caps.get(0) {
                                extracted.insert(ext.name.clone(), m.as_str().to_string());
                                variables.insert(ext.name.clone(), m.as_str().to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    StepResult {
        step_id: step.id.clone(),
        success: true,
        latency_ms: start.elapsed().as_millis() as i64,
        status: None,
        response_body: None,
        extracted_variables: if extracted.is_empty() { None } else { Some(extracted) },
        error: None,
    }
}

/// Execute a workflow
#[napi]
pub async fn workflow_execute(
    skill: WorkflowSkill,
    inputs: Option<HashMap<String, String>>,
    auth_headers: Option<HashMap<String, String>>,
    cookies: Option<HashMap<String, String>>,
    browser_port: Option<u32>,
) -> Result<WorkflowResult> {
    let start = std::time::Instant::now();
    let mut variables = inputs.unwrap_or_default();
    let auth_headers = auth_headers.unwrap_or_default();
    let cookies = cookies.unwrap_or_default();

    let mut step_results: Vec<StepResult> = Vec::new();
    let total_steps = skill.steps.len() as i32;
    let mut steps_completed = 0;
    let mut overall_success = true;
    let mut error: Option<String> = None;

    for step in &skill.steps {
        let result = execute_step(step, &mut variables, &auth_headers, &cookies, browser_port).await;

        if !result.success {
            overall_success = false;
            error = result.error.clone();
            step_results.push(result);
            break;
        }

        steps_completed += 1;
        step_results.push(result);
    }

    Ok(WorkflowResult {
        workflow_id: skill.id,
        success: overall_success,
        total_latency_ms: start.elapsed().as_millis() as i64,
        steps_completed,
        steps_total: total_steps,
        step_results,
        final_variables: variables,
        error,
    })
}
