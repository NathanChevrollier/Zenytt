//! Dialogue avec un modèle de langage, avec appels d'outils.
//!
//! Deux dialectes couvrent tous les fournisseurs visés :
//! - **Anthropic** (`POST /v1/messages`) pour Claude ;
//! - **compatible OpenAI** (`POST /chat/completions`) pour OpenAI, Mistral, Groq, OpenRouter et
//!   les modèles locaux (Ollama, LM Studio), qui exposent tous cette API.
//!
//! La construction des requêtes et la lecture des réponses sont séparées du réseau : elles sont
//! testées sans appeler quoi que ce soit.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    /// API Messages d'Anthropic (Claude).
    #[default]
    Anthropic,
    /// API compatible OpenAI : OpenAI, Mistral, Groq, OpenRouter, Ollama, LM Studio…
    OpenAi,
}

/// Fournisseur, adresse et modèle. La clé est fournie à part (elle vient du coffre de l'OS).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub provider: Provider,
    /// Adresse de base ; vide = celle du fournisseur par défaut.
    #[serde(default)]
    pub base_url: String,
    pub model: String,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
}

fn default_max_tokens() -> u32 {
    8000
}

impl Default for Config {
    fn default() -> Self {
        Self {
            provider: Provider::Anthropic,
            base_url: String::new(),
            model: DEFAULT_CLAUDE_MODEL.into(),
            max_tokens: default_max_tokens(),
        }
    }
}

/// Modèle Claude par défaut (le plus capable de la génération actuelle).
pub const DEFAULT_CLAUDE_MODEL: &str = "claude-opus-5";
const ANTHROPIC_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Adresse d'API acceptable : HTTPS, ou HTTP vers la machine locale ou le réseau privé (Ollama,
/// LM Studio sur un autre poste de la maison). Une clé d'API et le contenu des serveurs ne doivent
/// jamais circuler en clair sur Internet.
pub fn check_base_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Ok(());
    }
    let lower = url.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("https://") {
        return if rest.is_empty() { Err("adresse d'API incomplète".into()) } else { Ok(()) };
    }
    let Some(rest) = lower.strip_prefix("http://") else {
        return Err("l'adresse de l'API doit commencer par https:// (ou http:// pour un modèle local)".into());
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    // Retire un éventuel identifiant (`user@`) puis le port.
    let host_port = authority.rsplit('@').next().unwrap_or_default();
    let host = if let Some(v6) = host_port.strip_prefix('[') {
        v6.split(']').next().unwrap_or_default()
    } else {
        host_port.split(':').next().unwrap_or_default()
    };
    let local =
        host == "localhost" || host == "::1" || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback() || ip.is_private());
    if local {
        Ok(())
    } else {
        Err("http:// n'est accepté que pour un modèle local (localhost ou réseau privé) : utilise https:// pour un fournisseur distant"
            .into())
    }
}

impl Config {
    fn base(&self) -> &str {
        let trimmed = self.base_url.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            trimmed
        } else if self.provider == Provider::Anthropic {
            ANTHROPIC_URL
        } else {
            "https://api.openai.com/v1"
        }
    }

    /// Adresse complète de l'appel.
    pub fn endpoint(&self) -> String {
        match self.provider {
            Provider::Anthropic => format!("{}/v1/messages", self.base()),
            Provider::OpenAi => format!("{}/chat/completions", self.base()),
        }
    }

    /// En-têtes d'authentification (une clé vide est acceptée : les modèles locaux n'en ont pas).
    pub fn headers(&self, api_key: &str) -> Vec<(&'static str, String)> {
        let mut h = vec![("content-type", "application/json".to_string())];
        match self.provider {
            Provider::Anthropic => {
                h.push(("x-api-key", api_key.to_string()));
                h.push(("anthropic-version", ANTHROPIC_VERSION.to_string()));
            }
            Provider::OpenAi => {
                if !api_key.is_empty() {
                    h.push(("authorization", format!("Bearer {api_key}")));
                }
            }
        }
        h
    }
}

/// Outil proposé au modèle.
#[derive(Debug, Clone, PartialEq)]
pub struct Tool {
    pub name: String,
    pub description: String,
    /// Schéma JSON des paramètres.
    pub schema: Value,
}

/// Appel d'outil demandé par le modèle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
}

/// Résultat renvoyé au modèle après l'exécution d'un outil.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub id: String,
    pub content: String,
    pub is_error: bool,
}

/// Tour de conversation.
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    User(String),
    Assistant { text: String, tool_calls: Vec<ToolCall> },
    ToolResults(Vec<ToolResult>),
}

/// Raison d'arrêt du modèle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stop {
    /// Le modèle a terminé sa réponse.
    End,
    /// Il demande l'exécution d'outils.
    Tools,
    /// La limite de longueur a été atteinte.
    Length,
    /// Le modèle a refusé de répondre.
    Refusal,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub stop: Stop,
    /// Jetons consommés (entrée, sortie), quand le fournisseur les donne.
    pub input_tokens: u64,
    pub output_tokens: u64,
}

fn anthropic_messages(history: &[Message]) -> Vec<Value> {
    let mut out = Vec::new();
    for m in history {
        match m {
            Message::User(text) => out.push(json!({ "role": "user", "content": text })),
            Message::Assistant { text, tool_calls } => {
                let mut blocks = Vec::new();
                if !text.trim().is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                for c in tool_calls {
                    blocks.push(json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": c.input }));
                }
                if !blocks.is_empty() {
                    out.push(json!({ "role": "assistant", "content": blocks }));
                }
            }
            // Tous les résultats d'un même tour vont dans un seul message : les séparer
            // apprendrait au modèle à ne plus demander d'appels en parallèle.
            Message::ToolResults(results) => {
                let blocks: Vec<Value> = results
                    .iter()
                    .map(|r| json!({ "type": "tool_result", "tool_use_id": r.id, "content": r.content, "is_error": r.is_error }))
                    .collect();
                out.push(json!({ "role": "user", "content": blocks }));
            }
        }
    }
    out
}

fn openai_messages(history: &[Message]) -> Vec<Value> {
    let mut out = Vec::new();
    for m in history {
        match m {
            Message::User(text) => out.push(json!({ "role": "user", "content": text })),
            Message::Assistant { text, tool_calls } => {
                let mut msg = json!({ "role": "assistant", "content": text });
                if !tool_calls.is_empty() {
                    msg["tool_calls"] = Value::Array(
                        tool_calls
                            .iter()
                            .map(|c| {
                                json!({
                                    "id": c.id,
                                    "type": "function",
                                    "function": { "name": c.name, "arguments": c.input.to_string() },
                                })
                            })
                            .collect(),
                    );
                }
                out.push(msg);
            }
            Message::ToolResults(results) => {
                for r in results {
                    out.push(json!({ "role": "tool", "tool_call_id": r.id, "content": r.content }));
                }
            }
        }
    }
    out
}

/// Corps de la requête envoyée au fournisseur.
pub fn build_request(config: &Config, system: &str, history: &[Message], tools: &[Tool]) -> Value {
    match config.provider {
        Provider::Anthropic => {
            let mut body = json!({
                "model": config.model,
                "max_tokens": config.max_tokens,
                "system": system,
                "messages": anthropic_messages(history),
            });
            if !tools.is_empty() {
                body["tools"] = Value::Array(
                    tools.iter().map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.schema })).collect(),
                );
            }
            body
        }
        Provider::OpenAi => {
            let mut messages = vec![json!({ "role": "system", "content": system })];
            messages.extend(openai_messages(history));
            let mut body = json!({ "model": config.model, "max_tokens": config.max_tokens, "messages": messages });
            if !tools.is_empty() {
                body["tools"] = Value::Array(
                    tools
                        .iter()
                        .map(|t| {
                            json!({
                                "type": "function",
                                "function": { "name": t.name, "description": t.description, "parameters": t.schema },
                            })
                        })
                        .collect(),
                );
            }
            body
        }
    }
}

/// Lit la réponse du fournisseur.
pub fn parse_reply(provider: Provider, body: &Value) -> Result<Reply, String> {
    if let Some(message) = body["error"]["message"].as_str() {
        return Err(message.to_string());
    }
    match provider {
        Provider::Anthropic => {
            let mut text = String::new();
            let mut tool_calls = Vec::new();
            for block in body["content"].as_array().unwrap_or(&vec![]) {
                match block["type"].as_str() {
                    Some("text") => text.push_str(block["text"].as_str().unwrap_or_default()),
                    Some("tool_use") => tool_calls.push(ToolCall {
                        id: block["id"].as_str().unwrap_or_default().to_string(),
                        name: block["name"].as_str().unwrap_or_default().to_string(),
                        input: block["input"].clone(),
                    }),
                    _ => {}
                }
            }
            let stop = match body["stop_reason"].as_str() {
                Some("tool_use") => Stop::Tools,
                Some("max_tokens") => Stop::Length,
                Some("refusal") => Stop::Refusal,
                _ => Stop::End,
            };
            Ok(Reply {
                text,
                tool_calls,
                stop,
                input_tokens: body["usage"]["input_tokens"].as_u64().unwrap_or(0),
                output_tokens: body["usage"]["output_tokens"].as_u64().unwrap_or(0),
            })
        }
        Provider::OpenAi => {
            let choice = &body["choices"][0];
            let message = &choice["message"];
            let tool_calls: Vec<ToolCall> = message["tool_calls"]
                .as_array()
                .map(|calls| {
                    calls
                        .iter()
                        .map(|c| ToolCall {
                            id: c["id"].as_str().unwrap_or_default().to_string(),
                            name: c["function"]["name"].as_str().unwrap_or_default().to_string(),
                            // Les arguments arrivent en texte JSON : toujours les analyser.
                            input: c["function"]["arguments"]
                                .as_str()
                                .and_then(|a| serde_json::from_str(a).ok())
                                .unwrap_or_else(|| json!({})),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let stop = match choice["finish_reason"].as_str() {
                Some("tool_calls") => Stop::Tools,
                Some("length") => Stop::Length,
                Some("content_filter") => Stop::Refusal,
                _ if !tool_calls.is_empty() => Stop::Tools,
                _ => Stop::End,
            };
            Ok(Reply {
                text: message["content"].as_str().unwrap_or_default().to_string(),
                tool_calls,
                stop,
                input_tokens: body["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
                output_tokens: body["usage"]["completion_tokens"].as_u64().unwrap_or(0),
            })
        }
    }
}

/// Message d'erreur lisible à partir d'une réponse en échec.
pub fn error_message(status: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().or(v["message"].as_str()).map(str::to_string))
        .unwrap_or_else(|| body.chars().take(300).collect());
    match status {
        401 | 403 => format!("clé d'API refusée ({status}) : {detail}"),
        404 => format!("modèle ou adresse introuvable (404) : {detail}"),
        429 => format!("trop de requêtes (429) : {detail}"),
        s if s >= 500 => format!("le fournisseur est en erreur ({s}) : {detail}"),
        s => format!("erreur {s} : {detail}"),
    }
}

/// Envoie la requête et lit la réponse (appel bloquant : à lancer hors du fil de l'interface).
pub fn send(config: &Config, api_key: &str, body: &Value, timeout: Duration) -> Result<Reply, String> {
    check_base_url(&config.base_url)?;
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(timeout)).http_status_as_error(false).build().into();
    let mut request = agent.post(config.endpoint());
    for (name, value) in config.headers(api_key) {
        request = request.header(name, value);
    }
    let mut response = request.send_json(body).map_err(|e| format!("appel impossible : {e}"))?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().map_err(|e| e.to_string())?;
    if status >= 400 {
        return Err(error_message(status, &text));
    }
    let value: Value = serde_json::from_str(&text).map_err(|_| "réponse illisible du fournisseur".to_string())?;
    parse_reply(config.provider, &value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tools() -> Vec<Tool> {
        vec![Tool {
            name: "server_status".into(),
            description: "État d'un serveur".into(),
            schema: json!({ "type": "object", "properties": { "server": { "type": "string" } }, "required": ["server"] }),
        }]
    }

    fn history() -> Vec<Message> {
        vec![
            Message::User("pourquoi mon site est down ?".into()),
            Message::Assistant {
                text: "Je regarde.".into(),
                tool_calls: vec![ToolCall { id: "call_1".into(), name: "server_status".into(), input: json!({ "server": "vps" }) }],
            },
            Message::ToolResults(vec![ToolResult { id: "call_1".into(), content: "CPU 5 %".into(), is_error: false }]),
        ]
    }

    #[test]
    fn anthropic_request() {
        let c = Config::default();
        assert_eq!(c.endpoint(), "https://api.anthropic.com/v1/messages");
        assert_eq!(c.model, "claude-opus-5");
        let headers = c.headers("sk-test");
        assert!(headers.contains(&("x-api-key", "sk-test".into())) && headers.contains(&("anthropic-version", "2023-06-01".into())));

        let body = build_request(&c, "tu es zenytt", &history(), &tools());
        assert_eq!(body["system"], "tu es zenytt");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[1]["content"][1]["type"], "tool_use");
        assert_eq!(msgs[1]["content"][1]["id"], "call_1");
        // Les résultats d'outils reviennent dans un message « user » unique.
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[2]["content"][0]["tool_use_id"], "call_1");
    }

    #[test]
    fn anthropic_reply() {
        let body = json!({
            "content": [
                { "type": "text", "text": "Je vérifie les conteneurs." },
                { "type": "tool_use", "id": "toolu_1", "name": "list_containers", "input": { "server": "vps" } }
            ],
            "stop_reason": "tool_use",
            "usage": { "input_tokens": 1200, "output_tokens": 80 }
        });
        let r = parse_reply(Provider::Anthropic, &body).unwrap();
        assert_eq!(r.stop, Stop::Tools);
        assert_eq!(r.text, "Je vérifie les conteneurs.");
        assert_eq!(r.tool_calls[0].name, "list_containers");
        assert_eq!(r.tool_calls[0].input["server"], "vps");
        assert_eq!((r.input_tokens, r.output_tokens), (1200, 80));

        let refus = json!({ "content": [], "stop_reason": "refusal" });
        assert_eq!(parse_reply(Provider::Anthropic, &refus).unwrap().stop, Stop::Refusal);
        let erreur = json!({ "type": "error", "error": { "message": "credit balance too low" } });
        assert!(parse_reply(Provider::Anthropic, &erreur).unwrap_err().contains("credit"));
    }

    #[test]
    fn openai_request_and_reply() {
        let c = Config {
            provider: Provider::OpenAi,
            base_url: "http://localhost:11434/v1/".into(),
            model: "llama3.1".into(),
            max_tokens: 2000,
        };
        assert_eq!(c.endpoint(), "http://localhost:11434/v1/chat/completions");
        // Modèle local : aucune clé, donc aucun en-tête d'autorisation.
        assert!(!c.headers("").iter().any(|(n, _)| *n == "authorization"));

        let body = build_request(&c, "tu es zenytt", &history(), &tools());
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(body["tools"][0]["function"]["name"], "server_status");
        assert_eq!(msgs[2]["tool_calls"][0]["function"]["arguments"], "{\"server\":\"vps\"}");
        assert_eq!(msgs[3]["role"], "tool");
        assert_eq!(msgs[3]["tool_call_id"], "call_1");

        let reply = json!({
            "choices": [{
                "message": { "content": null, "tool_calls": [{ "id": "call_9", "type": "function", "function": { "name": "list_sites", "arguments": "{\"server\": \"vps\"}" } }] },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 5 }
        });
        let r = parse_reply(Provider::OpenAi, &reply).unwrap();
        assert_eq!(r.stop, Stop::Tools);
        assert_eq!(r.tool_calls[0].input["server"], "vps", "les arguments texte sont analysés en JSON");
        assert_eq!(r.text, "");
    }

    /// Faux fournisseur local : vérifie l'envoi réel (adresse, en-têtes, corps) et la lecture.
    #[test]
    fn full_http_round_trip() {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // Lecture bornée : le test ne reste jamais bloqué si le client n'envoie rien.
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let (mut request, mut length) = (String::new(), 0usize);
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap_or(0);
                }
                request.push_str(&line);
                // Ligne vide : fin des en-têtes (ou connexion fermée).
                if line.trim().is_empty() {
                    break;
                }
            }
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body).unwrap();
            let reply = serde_json::json!({
                "choices": [{ "message": { "content": "Le disque est plein." }, "finish_reason": "stop" }],
                "usage": { "prompt_tokens": 42, "completion_tokens": 7 }
            })
            .to_string();
            let head = format!("HTTP/1.1 200 OK@Content-Type: application/json@Content-Length: {}@Connection: close@@", reply.len());
            stream.write_all(head.replace('@', "\r\n").as_bytes()).unwrap();
            stream.write_all(reply.as_bytes()).unwrap();
            (request, String::from_utf8(body).unwrap())
        });

        let config = Config {
            provider: Provider::OpenAi,
            base_url: format!("http://127.0.0.1:{port}/v1"),
            model: "modele-local".into(),
            max_tokens: 100,
        };
        let body = build_request(&config, "tu es zenytt", &[Message::User("pourquoi ?".into())], &[]);
        let reply = send(&config, "cle-test", &body, Duration::from_secs(10)).unwrap();
        assert_eq!(reply.text, "Le disque est plein.");
        assert_eq!((reply.stop, reply.input_tokens, reply.output_tokens), (Stop::End, 42, 7));

        let (request, sent) = server.join().unwrap();
        assert!(request.starts_with("POST /v1/chat/completions "), "{request}");
        assert!(request.to_ascii_lowercase().contains("authorization: bearer cle-test"));
        assert!(sent.contains("modele-local") && sent.contains("tu es zenytt") && sent.contains("pourquoi ?"));
    }

    #[test]
    fn readable_errors() {
        assert!(error_message(401, r#"{"error":{"message":"invalid x-api-key"}}"#).contains("clé d'API refusée"));
        assert!(error_message(429, "{}").starts_with("trop de requêtes"));
        assert!(error_message(503, "indisponible").contains("fournisseur est en erreur"));
    }

    #[test]
    fn base_url_must_be_encrypted_unless_local() {
        for ok in [
            "",
            "https://api.openai.com/v1",
            "http://localhost:11434/v1",
            "http://127.0.0.1:1234/v1",
            "http://[::1]:8080/v1",
            "http://192.168.1.10:11434/v1",
        ] {
            assert!(check_base_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://api.example.com/v1",
            "http://8.8.8.8/v1",
            "http://localhost.evil.com/v1",
            "http://127.0.0.1@evil.com/v1",
            "ftp://x",
            "api.openai.com",
        ] {
            assert!(check_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn gemini_openai_compatible_endpoint() {
        for base in ["https://generativelanguage.googleapis.com/v1beta/openai", "https://generativelanguage.googleapis.com/v1beta/openai/"] {
            assert!(check_base_url(base).is_ok());
            let c = Config { provider: Provider::OpenAi, base_url: base.into(), ..Config::default() };
            assert_eq!(c.endpoint(), "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
        }
    }
}
