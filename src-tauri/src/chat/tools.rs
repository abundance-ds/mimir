use super::*;

pub(super) fn reserve_native_tool_names(registry: &ToolRegistry) -> Result<(), String> {
    for (canonical, alias) in [
        ("chat.rooms", "chat_rooms"),
        ("chat.read", "chat_read"),
        ("chat.search", "chat_search"),
        ("chat.send", "chat_send"),
        ("chat.download", "chat_download"),
    ] {
        registry
            .reserve_core_tool(canonical, alias)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn register_native_tools(registry: &ToolRegistry, runtime: &ChatRuntime) -> Result<(), String> {
    register_tool(
        registry,
        runtime,
        "chat.rooms",
        "chat_rooms",
        "List chat rooms.",
        object_schema(json!({}), &[]),
        true,
    )?;
    register_tool(
        registry,
        runtime,
        "chat.read",
        "chat_read",
        "Read chat messages.",
        object_schema(
            json!({
                "target": { "type": "string", "description": "Channel or account; default linked/open room." },
                "before": { "type": "string", "description": "Page before this message ID." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
            }),
            &[],
        ),
        true,
    )?;
    register_tool(
        registry,
        runtime,
        "chat.search",
        "chat_search",
        "Search chat messages.",
        object_schema(
            json!({
                "query": { "type": "string" },
                "target": { "type": "string", "description": "Room filter; default linked/open room, else all." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }
            }),
            &["query"],
        ),
        true,
    )?;
    register_tool(
        registry,
        runtime,
        "chat.send",
        "chat_send",
        "Send a chat message.",
        object_schema(
            json!({
                "target": { "type": "string", "description": "Channel or account; default linked/open room." },
                "text": { "type": "string" },
                "reply_to": { "type": "string", "description": "Message ID to reply to." }
            }),
            &["text"],
        ),
        false,
    )?;
    register_tool(
        registry,
        runtime,
        "chat.download",
        "chat_download",
        "Download a chat attachment; returns its verified local path.",
        object_schema(
            json!({
                "file_id": { "type": "string", "description": "Attachment ID from chat_read." }
            }),
            &["file_id"],
        ),
        false,
    )?;
    Ok(())
}

pub(super) fn register_tool(
    registry: &ToolRegistry,
    runtime: &ChatRuntime,
    canonical: &'static str,
    alias: &'static str,
    description: &'static str,
    schema: Value,
    read_only: bool,
) -> Result<(), String> {
    let runtime = runtime.clone();
    let registration = ToolRegistration::new(
        ToolDescriptor::new(
            canonical,
            alias,
            description,
            schema,
            ToolOwner::Core,
            ToolSource::Native,
        )
        .with_annotations(ToolAnnotations {
            read_only_hint: Some(read_only),
            destructive_hint: Some(false),
            idempotent_hint: read_only.then_some(true),
        }),
        move |context: ToolCallContext, input: Value| {
            let runtime = runtime.clone();
            async move {
                if canonical == "chat.download" {
                    let file_id =
                        input
                            .get("file_id")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                ToolError::new(ToolErrorCode::Handler, "file_id is required")
                            })?;
                    return runtime
                        .download_attachment(file_id)
                        .await
                        .map(|attachment| ToolResult::new(json!({ "attachment": attachment })))
                        .map_err(|message| ToolError::new(ToolErrorCode::Handler, message));
                }
                let execute = || -> Result<Value, String> {
                    let result = match canonical {
                        "chat.read" => {
                            let target = runtime.resolve_tool_target(
                                &context,
                                input.get("target").and_then(Value::as_str),
                            )?;
                            let messages = runtime.messages(
                                &target,
                                input.get("before").and_then(Value::as_str),
                                input.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize,
                            )?;
                            json!({
                                "target": target,
                                "status": runtime.status(),
                                "messages": messages,
                            })
                        }
                        "chat.rooms" => {
                            let rooms = runtime
                                .targets()?
                                .into_iter()
                                .map(|room| {
                                    json!({
                                        "id": room.id,
                                        "kind": room.kind.as_str(),
                                        "topic": room.topic,
                                        "unread": room.unread_count,
                                    })
                                })
                                .collect::<Vec<_>>();
                            json!({ "rooms": rooms })
                        }
                        "chat.search" => {
                            // Explicit or linked/active room scopes the search;
                            // with neither, search every room.
                            let target = match input.get("target").and_then(Value::as_str) {
                                Some(requested) => Some(normalize_target(requested)?),
                                None => runtime.resolve_tool_target(&context, None).ok(),
                            };
                            let query = input
                                .get("query")
                                .and_then(Value::as_str)
                                .ok_or_else(|| "query is required".to_string())?;
                            let messages = runtime.search(
                                query,
                                target.as_deref(),
                                input.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize,
                            )?;
                            json!({ "target": target, "messages": messages })
                        }
                        "chat.send" => {
                            let target = runtime.resolve_tool_target(
                                &context,
                                input.get("target").and_then(Value::as_str),
                            )?;
                            let text = input
                                .get("text")
                                .and_then(Value::as_str)
                                .ok_or_else(|| "text is required".to_string())?;
                            let label = runtime.resolve_agent_label(&context);
                            let activity_id =
                                context.metadata.get("activityId").and_then(Value::as_str);
                            runtime.send(
                                &target,
                                text,
                                input.get("reply_to").and_then(Value::as_str),
                                Some(&label),
                                activity_id,
                            )?;
                            json!({ "target": target, "queued": true, "agent": label })
                        }
                        _ => return Err("Unknown chat tool.".to_string()),
                    };
                    Ok(result)
                };
                execute()
                    .map(ToolResult::new)
                    .map_err(|message| ToolError::new(ToolErrorCode::Handler, message))
            }
        },
    );
    registry
        .register(registration)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub(super) fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}
