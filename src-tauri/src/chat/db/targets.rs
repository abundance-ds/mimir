use super::*;

impl ChatDatabase {
    pub fn ensure_target(
        &self,
        target: &str,
        kind: ChatTargetKind,
        joined: bool,
        initial_read_at: Option<&str>,
    ) -> Result<(), String> {
        let title = target.trim_start_matches(['#', '&']).to_string();
        self.connection()?
            .execute(
                "
                INSERT INTO chat_targets
                    (target, kind, title, joined, last_read_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(target) DO UPDATE SET
                    kind = excluded.kind,
                    title = excluded.title,
                    joined = CASE WHEN excluded.joined = 1 THEN 1 ELSE chat_targets.joined END
                ",
                params![target, kind.as_str(), title, joined, initial_read_at],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn set_joined(&self, target: &str, joined: bool) -> Result<(), String> {
        self.connection()?
            .execute(
                "UPDATE chat_targets SET joined = ?2 WHERE target = ?1",
                params![target, joined],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn set_topic(&self, target: &str, topic: &str) -> Result<(), String> {
        self.connection()?
            .execute(
                "UPDATE chat_targets SET topic = ?2 WHERE target = ?1",
                params![target, topic],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn replace_members(&self, target: &str, nicks: &[String]) -> Result<(), String> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE chat_members SET active = 0 WHERE target = ?1",
                params![target],
            )
            .map_err(|error| error.to_string())?;
        for nick in nicks {
            transaction
                .execute(
                    "
                    INSERT INTO chat_members(target, nick, display_name, active)
                    VALUES (?1, ?2, ?2, 1)
                    ON CONFLICT(target, nick) DO UPDATE SET active = 1
                    ",
                    params![target, nick],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction
            .execute(
                "UPDATE chat_targets SET member_count = ?2 WHERE target = ?1",
                params![target, nicks.len() as u32],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    pub fn upsert_member(
        &self,
        target: &str,
        nick: &str,
        account: Option<&str>,
        display_name: Option<&str>,
    ) -> Result<(), String> {
        let connection = self.connection()?;
        connection
            .execute(
                "
                INSERT INTO chat_members(target, nick, account, display_name, active)
                VALUES (?1, ?2, ?3, COALESCE(?4, ?2), 1)
                ON CONFLICT(target, nick) DO UPDATE SET
                    account = COALESCE(excluded.account, chat_members.account),
                    display_name = CASE
                        WHEN ?4 IS NULL OR ?4 = '' THEN chat_members.display_name
                        ELSE ?4
                    END,
                    active = 1
                ",
                params![target, nick, account, display_name],
            )
            .map_err(|error| error.to_string())?;
        update_member_count(&connection, target)?;
        Ok(())
    }

    pub fn remove_member(&self, target: &str, nick: &str) -> Result<(), String> {
        let connection = self.connection()?;
        connection
            .execute(
                "UPDATE chat_members SET active = 0 WHERE target = ?1 AND nick = ?2",
                params![target, nick],
            )
            .map_err(|error| error.to_string())?;
        update_member_count(&connection, target)?;
        Ok(())
    }

    pub fn remove_member_everywhere(&self, nick: &str) -> Result<(), String> {
        let connection = self.connection()?;
        connection
            .execute(
                "UPDATE chat_members SET active = 0 WHERE nick = ?1",
                params![nick],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "
                UPDATE chat_targets
                SET member_count = (
                    SELECT COUNT(*)
                    FROM chat_members
                    WHERE chat_members.target = chat_targets.target
                      AND active = 1
                )
                WHERE kind = 'channel'
                ",
                [],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn update_member_profile(&self, nick: &str, display_name: &str) -> Result<(), String> {
        self.connection()?
            .execute(
                "UPDATE chat_members SET display_name = ?2 WHERE nick = ?1",
                params![nick, display_name],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn update_member_presence(
        &self,
        nick: &str,
        away: bool,
        away_message: Option<&str>,
    ) -> Result<(), String> {
        self.connection()?
            .execute(
                "
                UPDATE chat_members
                SET away = ?2, away_message = ?3
                WHERE nick = ?1
                ",
                params![nick, away, away_message],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn members(&self, target: Option<&str>) -> Result<Vec<ChatMember>, String> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "
                SELECT nick, MAX(account), MAX(NULLIF(display_name, '')),
                       MAX(away), MAX(NULLIF(away_message, ''))
                FROM chat_members
                WHERE active = 1
                  AND (?1 IS NULL OR target = ?1)
                GROUP BY lower(nick)
                ORDER BY lower(COALESCE(MAX(NULLIF(display_name, '')), nick))
                ",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![target], |row| {
                let nick: String = row.get(0)?;
                let display_name = row
                    .get::<_, Option<String>>(2)?
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| nick.clone());
                Ok(ChatMember {
                    nick,
                    account: row.get(1)?,
                    display_name,
                    away: row.get::<_, i64>(3)? != 0,
                    away_message: row.get(4)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn set_muted(&self, target: &str, muted: bool) -> Result<(), String> {
        self.connection()?
            .execute(
                "UPDATE chat_targets SET muted = ?2 WHERE target = ?1",
                params![target, muted],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn set_hidden(&self, target: &str, hidden: bool) -> Result<(), String> {
        self.connection()?
            .execute(
                "UPDATE chat_targets SET hidden = ?2 WHERE target = ?1",
                params![target, hidden],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}
