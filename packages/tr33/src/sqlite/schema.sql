CREATE TABLE `_blobs` (
	`org_name` text NOT NULL,
	`repo_name` text NOT NULL,
	`oid` text NOT NULL,
	`content` text NOT NULL,
	CONSTRAINT `_blobs_pk` PRIMARY KEY(`org_name`, `repo_name`, `oid`)
);

CREATE TABLE `_commits` (
	`org_name` text NOT NULL,
	`repo_name` text NOT NULL,
	`oid` text NOT NULL,
	`tree_oid` text NOT NULL,
	`message` text NOT NULL,
	`parent` text,
	`second_parent` text,
	`author_name` text NOT NULL,
	`author_email` text NOT NULL,
	`author_timestamp` integer NOT NULL,
	`author_timezone_offset` integer NOT NULL,
	`committer_name` text NOT NULL,
	`committer_email` text NOT NULL,
	`committer_timestamp` integer NOT NULL,
	`committer_timezone_offset` integer NOT NULL,
	`pushed_at` integer,
	CONSTRAINT `_commits_pk` PRIMARY KEY(`org_name`, `repo_name`, `oid`)
);

CREATE TABLE `_refs` (
	`org_name` text NOT NULL,
	`repo_name` text NOT NULL,
	`ref` text NOT NULL,
	`commit_oid` text NOT NULL,
	`remote_commit_oid` text,
	`root_tree_oid` text,
	`versions` text,
	CONSTRAINT `_refs_pk` PRIMARY KEY(`org_name`, `repo_name`, `ref`)
);

CREATE TABLE `_trees` (
	`org_name` text NOT NULL,
	`repo_name` text NOT NULL,
	`oid` text NOT NULL,
	`entries` text NOT NULL,
	CONSTRAINT `_trees_pk` PRIMARY KEY(`org_name`, `repo_name`, `oid`)
);

CREATE TABLE `connections` (
	`org_name` text NOT NULL,
	`repo_name` text NOT NULL,
	`ref` text NOT NULL,
	`version` text NOT NULL,
	`path` text NOT NULL,
	`field` text NOT NULL,
	`referenced_as` text,
	`key` text NOT NULL,
	`to` text NOT NULL,
	`literal` text NOT NULL,
	`collection` text NOT NULL,
	CONSTRAINT `connections_pk` PRIMARY KEY(`org_name`, `repo_name`, `ref`, `version`, `path`, `key`)
);

CREATE TABLE `entries` (
	`org_name` text NOT NULL,
	`repo_name` text NOT NULL,
	`ref` text NOT NULL,
	`version` text NOT NULL,
	`variant` text NOT NULL,
	`canonical` text NOT NULL,
	`path` text NOT NULL,
	`collection` text NOT NULL,
	`oid` text NOT NULL,
	CONSTRAINT `entries_pk` PRIMARY KEY(`org_name`, `repo_name`, `ref`, `version`, `variant`, `canonical`)
);

CREATE TABLE `filters` (
	`org_name` text NOT NULL,
	`repo_name` text NOT NULL,
	`ref` text NOT NULL,
	`version` text NOT NULL,
	`path` text NOT NULL,
	`field` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `filters_pk` PRIMARY KEY(`org_name`, `repo_name`, `ref`, `version`, `path`, `key`)
);

-- src/sqlite/better-auth-schema.sql
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");
