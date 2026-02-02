//! Core types for unbrowse - shared across all modules
//!
//! These types are exported to JavaScript via napi-rs and used internally.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================================
// HAR Types (Browser Network Capture)
// ============================================================================

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarHeader {
    pub name: String,
    pub value: String,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarCookie {
    pub name: String,
    pub value: String,
    #[napi(ts_type = "string | undefined")]
    pub domain: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub path: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub expires: Option<String>,
    #[napi(ts_type = "boolean | undefined")]
    pub http_only: Option<bool>,
    #[napi(ts_type = "boolean | undefined")]
    pub secure: Option<bool>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarPostData {
    #[napi(ts_type = "string | undefined")]
    pub mime_type: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub text: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<HarHeader>,
    #[napi(ts_type = "HarCookie[] | undefined")]
    pub cookies: Option<Vec<HarCookie>>,
    #[napi(ts_type = "HarPostData | undefined")]
    pub post_data: Option<HarPostData>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarContent {
    #[napi(ts_type = "number | undefined")]
    pub size: Option<i64>,
    #[napi(ts_type = "string | undefined")]
    pub mime_type: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub text: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarResponse {
    pub status: i32,
    pub headers: Vec<HarHeader>,
    #[napi(ts_type = "HarContent | undefined")]
    pub content: Option<HarContent>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarEntry {
    pub request: HarRequest,
    pub response: HarResponse,
    #[napi(ts_type = "string | undefined")]
    pub started_date_time: Option<String>,
    #[napi(ts_type = "number | undefined")]
    pub time: Option<f64>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarLog {
    pub entries: Vec<HarEntry>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Har {
    pub log: HarLog,
}

// ============================================================================
// Parsed API Data
// ============================================================================

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedRequest {
    pub method: String,
    pub url: String,
    pub path: String,
    pub domain: String,
    pub status: i32,
    #[napi(ts_type = "string | undefined")]
    pub response_content_type: Option<String>,
    #[napi(ts_type = "boolean | undefined")]
    pub from_spec: Option<bool>,
    #[napi(ts_type = "string | undefined")]
    pub request_body: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub response_body: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiData {
    pub service: String,
    pub base_urls: Vec<String>,
    pub base_url: String,
    pub auth_headers: HashMap<String, String>,
    pub auth_method: String,
    pub cookies: HashMap<String, String>,
    pub auth_info: HashMap<String, String>,
    pub requests: Vec<ParsedRequest>,
    pub endpoints: HashMap<String, Vec<ParsedRequest>>,
}

// ============================================================================
// Auth Types
// ============================================================================

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthJson {
    pub service: String,
    pub base_url: String,
    pub auth_method: String,
    #[napi(ts_type = "Record<string, string> | undefined")]
    pub headers: Option<HashMap<String, String>>,
    #[napi(ts_type = "Record<string, string> | undefined")]
    pub cookies: Option<HashMap<String, String>>,
    #[napi(ts_type = "Record<string, string> | undefined")]
    pub context: Option<HashMap<String, String>>,
    #[napi(ts_type = "RefreshConfig | undefined")]
    pub refresh: Option<RefreshConfig>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshConfig {
    pub endpoint: String,
    pub method: String,
    #[napi(ts_type = "Record<string, string> | undefined")]
    pub body: Option<HashMap<String, String>>,
    #[napi(ts_type = "string | undefined")]
    pub token_path: Option<String>,
    #[napi(ts_type = "number | undefined")]
    pub expires_in: Option<i64>,
}

// ============================================================================
// Skill Types
// ============================================================================

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillResult {
    pub service: String,
    pub skill_dir: String,
    pub skill_md_path: String,
    pub auth_json_path: String,
    pub api_ts_path: String,
    pub endpoints_count: i32,
    pub auth_method: String,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillMeta {
    #[napi(ts_type = "string | undefined")]
    pub description: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub author: Option<String>,
    #[napi(ts_type = "string[] | undefined")]
    pub tags: Option<Vec<String>>,
    #[napi(ts_type = "number | undefined")]
    pub price_usdc: Option<f64>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointInfo {
    pub method: String,
    pub path: String,
    #[napi(ts_type = "string | undefined")]
    pub description: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub response_type: Option<String>,
}

// ============================================================================
// Credential Types
// ============================================================================

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginCredential {
    pub username: String,
    pub password: String,
    #[napi(ts_type = "string | undefined")]
    pub source: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultEntry {
    pub service: String,
    pub base_url: String,
    pub auth_method: String,
    pub headers: HashMap<String, String>,
    pub cookies: HashMap<String, String>,
    pub updated_at: String,
}

// ============================================================================
// Browser Control Types
// ============================================================================

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserRequest {
    pub id: String,
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    #[napi(ts_type = "string | undefined")]
    pub body: Option<String>,
    pub status: i32,
    #[napi(ts_type = "string | undefined")]
    pub response_body: Option<String>,
    #[napi(ts_type = "Record<string, string> | undefined")]
    pub response_headers: Option<HashMap<String, String>>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageElement {
    pub index: i32,
    pub tag: String,
    #[napi(ts_type = "string | undefined")]
    pub element_type: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub role: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub text: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub placeholder: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub href: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub value: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub name: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub aria_label: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageSnapshot {
    pub url: String,
    pub title: String,
    pub elements: Vec<PageElement>,
}

// ============================================================================
// Marketplace Types
// ============================================================================

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub service: String,
    #[napi(ts_type = "string | undefined")]
    pub description: Option<String>,
    pub author: String,
    #[napi(ts_type = "string | undefined")]
    pub author_wallet: Option<String>,
    pub version: String,
    pub endpoints_count: i32,
    pub installs: i32,
    pub executions: i32,
    #[napi(ts_type = "number | undefined")]
    pub price_usdc: Option<f64>,
    #[napi(ts_type = "string[] | undefined")]
    pub tags: Option<Vec<String>>,
    #[napi(ts_type = "string | undefined")]
    pub badge: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillPackage {
    pub id: String,
    pub skill_md: String,
    #[napi(ts_type = "string | undefined")]
    pub api_ts: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub reference_md: Option<String>,
    pub auth_method: String,
    pub base_url: String,
    pub endpoints: Vec<EndpointInfo>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishPayload {
    pub service: String,
    pub skill_md: String,
    #[napi(ts_type = "string | undefined")]
    pub api_ts: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub reference_md: Option<String>,
    pub auth_method: String,
    pub base_url: String,
    pub endpoints: Vec<EndpointInfo>,
    #[napi(ts_type = "string | undefined")]
    pub description: Option<String>,
    #[napi(ts_type = "string[] | undefined")]
    pub tags: Option<Vec<String>>,
    #[napi(ts_type = "number | undefined")]
    pub price_usdc: Option<f64>,
}

// ============================================================================
// Workflow Types
// ============================================================================

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowStep {
    pub id: String,
    pub step_type: String, // "api_call" | "browser_action" | "wait" | "extract"
    #[napi(ts_type = "string | undefined")]
    pub url: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub method: Option<String>,
    #[napi(ts_type = "Record<string, string> | undefined")]
    pub headers: Option<HashMap<String, String>>,
    #[napi(ts_type = "string | undefined")]
    pub body: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub action: Option<String>, // "click" | "type" | "select"
    #[napi(ts_type = "string | undefined")]
    pub selector: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub value: Option<String>,
    #[napi(ts_type = "VariableExtraction[] | undefined")]
    pub extractions: Option<Vec<VariableExtraction>>,
    #[napi(ts_type = "string | undefined")]
    pub wait_for: Option<String>,
    #[napi(ts_type = "number | undefined")]
    pub timeout_ms: Option<i64>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VariableExtraction {
    pub name: String,
    pub source: String, // "response_body" | "response_header" | "dom" | "url"
    #[napi(ts_type = "string | undefined")]
    pub json_path: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub css_selector: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub regex: Option<String>,
    #[napi(ts_type = "string | undefined")]
    pub header_name: Option<String>,
}

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowSkill {
    pub id: String,
    pub name: String,
    #[napi(ts_type = "string | undefined")]
    pub description: Option<String>,
    pub steps: Vec<WorkflowStep>,
    #[napi(ts_type = "Record<string, string> | undefined")]
    pub inputs: Option<HashMap<String, String>>,
    #[napi(ts_type = "Record<string, string> | undefined")]
    pub outputs: Option<HashMap<String, String>>,
}

// ============================================================================
// Endpoint Test Results
// ============================================================================

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EndpointTestResult {
    pub url: String,
    pub method: String,
    pub status: i32,
    pub latency_ms: i64,
    #[napi(ts_type = "string | undefined")]
    pub response_shape: Option<String>, // "array[N]" | "object{fields}" | "non-json" | "error"
    #[napi(ts_type = "number | undefined")]
    pub response_size: Option<i64>,
    #[napi(ts_type = "string | undefined")]
    pub error: Option<String>,
}

// ============================================================================
// OTP Types
// ============================================================================

#[napi(object)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OtpResult {
    pub code: String,
    pub source: String, // "imessage" | "clipboard" | "notification" | "mail"
    #[napi(ts_type = "string | undefined")]
    pub sender: Option<String>,
    pub timestamp: String,
}
