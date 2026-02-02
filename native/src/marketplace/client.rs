//! Marketplace API client

use crate::types::*;
use napi::bindgen_prelude::*;
use napi_derive::napi;

const DEFAULT_INDEX_URL: &str = "https://unbrowse.getfoundry.sh";

/// Marketplace client
pub struct MarketplaceClient {
    base_url: String,
    client: reqwest::Client,
}

impl MarketplaceClient {
    pub fn new(base_url: Option<String>) -> Self {
        Self {
            base_url: base_url.unwrap_or_else(|| DEFAULT_INDEX_URL.to_string()),
            client: reqwest::Client::new(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }
}

/// Search marketplace skills
#[napi]
pub async fn marketplace_search(
    query: String,
    base_url: Option<String>,
) -> Result<Vec<SkillSummary>> {
    let client = MarketplaceClient::new(base_url);

    let resp = client
        .client
        .get(client.url("/marketplace/skills"))
        .query(&[("q", &query)])
        .send()
        .await
        .map_err(|e| Error::from_reason(format!("Search failed: {}", e)))?;

    if !resp.status().is_success() {
        return Err(Error::from_reason(format!(
            "Search failed: {}",
            resp.status()
        )));
    }

    let skills: Vec<SkillSummary> = resp
        .json()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to parse response: {}", e)))?;

    Ok(skills)
}

/// Get skill details
#[napi]
pub async fn marketplace_get_skill(
    skill_id: String,
    base_url: Option<String>,
) -> Result<Option<SkillSummary>> {
    let client = MarketplaceClient::new(base_url);

    let resp = client
        .client
        .get(client.url(&format!("/marketplace/skills/{}", skill_id)))
        .send()
        .await
        .map_err(|e| Error::from_reason(format!("Get skill failed: {}", e)))?;

    if resp.status().as_u16() == 404 {
        return Ok(None);
    }

    if !resp.status().is_success() {
        return Err(Error::from_reason(format!(
            "Get skill failed: {}",
            resp.status()
        )));
    }

    let skill: SkillSummary = resp
        .json()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to parse response: {}", e)))?;

    Ok(Some(skill))
}

/// Get trending skills
#[napi]
pub async fn marketplace_trending(base_url: Option<String>) -> Result<Vec<SkillSummary>> {
    let client = MarketplaceClient::new(base_url);

    let resp = client
        .client
        .get(client.url("/marketplace/trending"))
        .send()
        .await
        .map_err(|e| Error::from_reason(format!("Trending failed: {}", e)))?;

    if !resp.status().is_success() {
        return Err(Error::from_reason(format!(
            "Trending failed: {}",
            resp.status()
        )));
    }

    let skills: Vec<SkillSummary> = resp
        .json()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to parse response: {}", e)))?;

    Ok(skills)
}

/// Get featured skills
#[napi]
pub async fn marketplace_featured(base_url: Option<String>) -> Result<Vec<SkillSummary>> {
    let client = MarketplaceClient::new(base_url);

    let resp = client
        .client
        .get(client.url("/marketplace/featured"))
        .send()
        .await
        .map_err(|e| Error::from_reason(format!("Featured failed: {}", e)))?;

    if !resp.status().is_success() {
        return Err(Error::from_reason(format!(
            "Featured failed: {}",
            resp.status()
        )));
    }

    let skills: Vec<SkillSummary> = resp
        .json()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to parse response: {}", e)))?;

    Ok(skills)
}

/// Download a skill package
#[napi]
pub async fn marketplace_download(
    skill_id: String,
    wallet_signature: Option<String>,
    base_url: Option<String>,
) -> Result<SkillPackage> {
    let client = MarketplaceClient::new(base_url);

    let mut req = client
        .client
        .get(client.url(&format!("/marketplace/skills/{}/download", skill_id)));

    // Add x402 payment header if provided
    if let Some(sig) = wallet_signature {
        req = req.header("X-402-Payment", sig);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| Error::from_reason(format!("Download failed: {}", e)))?;

    // Handle payment required
    if resp.status().as_u16() == 402 {
        return Err(Error::from_reason(
            "Payment required - use wallet_sign_payment to sign the x402 payment",
        ));
    }

    if !resp.status().is_success() {
        return Err(Error::from_reason(format!(
            "Download failed: {}",
            resp.status()
        )));
    }

    let package: SkillPackage = resp
        .json()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to parse response: {}", e)))?;

    Ok(package)
}

/// Publish a skill to marketplace
#[napi]
pub async fn marketplace_publish(
    payload: PublishPayload,
    wallet_pubkey: String,
    wallet_signature: String,
    base_url: Option<String>,
) -> Result<SkillSummary> {
    let client = MarketplaceClient::new(base_url);

    let resp = client
        .client
        .post(client.url("/marketplace/skills"))
        .header("X-Wallet-Pubkey", wallet_pubkey)
        .header("X-Wallet-Signature", wallet_signature)
        .json(&payload)
        .send()
        .await
        .map_err(|e| Error::from_reason(format!("Publish failed: {}", e)))?;

    if !resp.status().is_success() {
        let error_text = resp.text().await.unwrap_or_default();
        return Err(Error::from_reason(format!(
            "Publish failed: {}",
            error_text
        )));
    }

    let skill: SkillSummary = resp
        .json()
        .await
        .map_err(|e| Error::from_reason(format!("Failed to parse response: {}", e)))?;

    Ok(skill)
}

/// Track skill installation
#[napi]
pub async fn marketplace_track_install(
    skill_id: String,
    base_url: Option<String>,
) -> Result<()> {
    let client = MarketplaceClient::new(base_url);

    let body = serde_json::json!({ "skillId": skill_id });

    let _ = client
        .client
        .post(client.url("/marketplace/installations"))
        .json(&body)
        .send()
        .await;

    Ok(())
}

/// Track skill execution
#[napi]
pub async fn marketplace_track_execution(
    skill_id: String,
    success: bool,
    latency_ms: Option<i32>,
    base_url: Option<String>,
) -> Result<()> {
    let client = MarketplaceClient::new(base_url);

    let body = serde_json::json!({
        "skillId": skill_id,
        "success": success,
        "latencyMs": latency_ms,
    });

    let _ = client
        .client
        .post(client.url("/marketplace/executions"))
        .json(&body)
        .send()
        .await;

    Ok(())
}
