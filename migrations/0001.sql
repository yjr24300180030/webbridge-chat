CREATE TABLE visitors (id TEXT PRIMARY KEY, created INTEGER NOT NULL);
CREATE TABLE conversations (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES visitors(id), title TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX conversation_owner ON conversations(owner, created);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversations(id), owner TEXT NOT NULL,
 prompt TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued',
 error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
 lease_token TEXT, lease_until INTEGER, connector TEXT, client_key TEXT NOT NULL,
 UNIQUE(owner, client_key)
);
CREATE INDEX job_queue ON jobs(status, created);
CREATE INDEX job_conversation ON jobs(conversation, created);
CREATE UNIQUE INDEX one_pending_turn ON jobs(conversation) WHERE status IN ('queued','running');
CREATE TABLE connectors (id TEXT PRIMARY KEY, seen INTEGER NOT NULL, ready INTEGER NOT NULL);
CREATE TABLE login_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
