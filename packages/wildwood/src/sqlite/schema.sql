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
	`slug` text DEFAULT '' NOT NULL,
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

CREATE TABLE `wildwood_access_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`permissions` text NOT NULL,
	`ref_selectors` text NOT NULL,
	`constraints` text,
	`kind` text DEFAULT 'custom' NOT NULL,
	`issued_by` text NOT NULL,
	`parent_grant_id` text,
	`created_at` date NOT NULL,
	`expires_at` date,
	`revoked_at` date,
	`uses_remaining` integer,
	CONSTRAINT `fk_wildwood_access_grant_project_id_wildwood_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `wildwood_project`(`id`),
	CONSTRAINT `fk_wildwood_access_grant_parent_grant_id_wildwood_access_grant_id_fk` FOREIGN KEY (`parent_grant_id`) REFERENCES `wildwood_access_grant`(`id`)
);

CREATE TABLE `wildwood_approval_request` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`permission` text NOT NULL,
	`source_ref` text NOT NULL,
	`target_ref` text NOT NULL,
	`source_commit` text NOT NULL,
	`reason` text,
	`status` text NOT NULL,
	`created_at` date NOT NULL,
	`expires_at` date NOT NULL,
	`decided_at` date,
	`decided_by` text,
	`grant_id` text,
	CONSTRAINT `fk_wildwood_approval_request_project_id_wildwood_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `wildwood_project`(`id`),
	CONSTRAINT `fk_wildwood_approval_request_grant_id_wildwood_access_grant_id_fk` FOREIGN KEY (`grant_id`) REFERENCES `wildwood_access_grant`(`id`)
);

CREATE TABLE `wildwood_auth_event` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`actor_id` text,
	`subject_id` text,
	`grant_id` text,
	`created_at` date NOT NULL,
	`metadata` text,
	CONSTRAINT `fk_wildwood_auth_event_project_id_wildwood_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `wildwood_project`(`id`)
);

CREATE TABLE `wildwood_auth_setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` date NOT NULL,
	`updated_at` date NOT NULL
);

CREATE TABLE `wildwood_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`grant_id` text,
	`secret_hash` text,
	`created_at` date NOT NULL,
	`expires_at` date,
	`revoked_at` date,
	CONSTRAINT `fk_wildwood_credential_project_id_wildwood_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `wildwood_project`(`id`),
	CONSTRAINT `fk_wildwood_credential_grant_id_wildwood_access_grant_id_fk` FOREIGN KEY (`grant_id`) REFERENCES `wildwood_access_grant`(`id`)
);

CREATE TABLE `wildwood_project` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`external_id` text,
	`org_name` text NOT NULL,
	`repo_name` text NOT NULL,
	`config_ref` text NOT NULL,
	`created_at` date NOT NULL,
	`updated_at` date NOT NULL
);

CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` date,
	`refreshTokenExpiresAt` date,
	`scope` text,
	`password` text,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL,
	CONSTRAINT `fk_account_userId_user_id_fk` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE
);

CREATE TABLE `deviceCode` (
	`id` text PRIMARY KEY NOT NULL,
	`deviceCode` text NOT NULL,
	`userCode` text NOT NULL,
	`userId` text,
	`expiresAt` date NOT NULL,
	`status` text NOT NULL,
	`lastPolledAt` date,
	`pollingInterval` integer,
	`clientId` text,
	`scope` text
);

CREATE TABLE `jwks` (
	`id` text PRIMARY KEY NOT NULL,
	`publicKey` text NOT NULL,
	`privateKey` text NOT NULL,
	`createdAt` date NOT NULL,
	`expiresAt` date
);

CREATE TABLE `oauthAccessToken` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text UNIQUE,
	`clientId` text NOT NULL,
	`sessionId` text,
	`userId` text,
	`referenceId` text,
	`authorizationCodeId` text,
	`resources` text,
	`requestedUserInfoClaims` text,
	`refreshId` text,
	`expiresAt` date,
	`createdAt` date,
	`revoked` date,
	`confirmation` text,
	`scopes` text NOT NULL,
	CONSTRAINT `fk_oauthAccessToken_clientId_oauthClient_clientId_fk` FOREIGN KEY (`clientId`) REFERENCES `oauthClient`(`clientId`),
	CONSTRAINT `fk_oauthAccessToken_sessionId_session_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `session`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_oauthAccessToken_userId_user_id_fk` FOREIGN KEY (`userId`) REFERENCES `user`(`id`),
	CONSTRAINT `fk_oauthAccessToken_refreshId_oauthRefreshToken_id_fk` FOREIGN KEY (`refreshId`) REFERENCES `oauthRefreshToken`(`id`)
);

CREATE TABLE `oauthClient` (
	`id` text PRIMARY KEY NOT NULL,
	`clientId` text NOT NULL UNIQUE,
	`clientSecret` text,
	`disabled` integer DEFAULT 0,
	`skipConsent` integer,
	`enableEndSession` integer,
	`subjectType` text,
	`scopes` text,
	`userId` text,
	`createdAt` date,
	`updatedAt` date,
	`name` text,
	`uri` text,
	`icon` text,
	`contacts` text,
	`tos` text,
	`policy` text,
	`softwareId` text,
	`softwareVersion` text,
	`softwareStatement` text,
	`redirectUris` text NOT NULL,
	`postLogoutRedirectUris` text,
	`backchannelLogoutUri` text,
	`backchannelLogoutSessionRequired` integer,
	`tokenEndpointAuthMethod` text,
	`jwks` text,
	`jwksUri` text,
	`grantTypes` text,
	`responseTypes` text,
	`public` integer,
	`type` text,
	`requirePKCE` integer,
	`dpopBoundAccessTokens` integer DEFAULT 0,
	`referenceId` text,
	`metadata` text,
	CONSTRAINT `fk_oauthClient_userId_user_id_fk` FOREIGN KEY (`userId`) REFERENCES `user`(`id`)
);

CREATE TABLE `oauthClientAssertion` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` date NOT NULL
);

CREATE TABLE `oauthClientResource` (
	`id` text PRIMARY KEY NOT NULL,
	`clientId` text NOT NULL,
	`resourceId` text NOT NULL,
	`metadata` text,
	`createdAt` date,
	CONSTRAINT `fk_oauthClientResource_clientId_oauthClient_clientId_fk` FOREIGN KEY (`clientId`) REFERENCES `oauthClient`(`clientId`),
	CONSTRAINT `fk_oauthClientResource_resourceId_oauthResource_identifier_fk` FOREIGN KEY (`resourceId`) REFERENCES `oauthResource`(`identifier`)
);

CREATE TABLE `oauthConsent` (
	`id` text PRIMARY KEY NOT NULL,
	`clientId` text NOT NULL,
	`userId` text,
	`referenceId` text,
	`resources` text,
	`requestedUserInfoClaims` text,
	`scopes` text NOT NULL,
	`createdAt` date,
	`updatedAt` date,
	CONSTRAINT `fk_oauthConsent_clientId_oauthClient_clientId_fk` FOREIGN KEY (`clientId`) REFERENCES `oauthClient`(`clientId`),
	CONSTRAINT `fk_oauthConsent_userId_user_id_fk` FOREIGN KEY (`userId`) REFERENCES `user`(`id`)
);

CREATE TABLE `oauthRefreshToken` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL UNIQUE,
	`clientId` text NOT NULL,
	`sessionId` text,
	`userId` text NOT NULL,
	`referenceId` text,
	`authorizationCodeId` text,
	`resources` text,
	`requestedUserInfoClaims` text,
	`expiresAt` date,
	`createdAt` date,
	`revoked` date,
	`rotatedAt` date,
	`rotationReplayResponse` text,
	`rotationReplayExpiresAt` date,
	`authTime` date,
	`confirmation` text,
	`scopes` text NOT NULL,
	CONSTRAINT `fk_oauthRefreshToken_clientId_oauthClient_clientId_fk` FOREIGN KEY (`clientId`) REFERENCES `oauthClient`(`clientId`),
	CONSTRAINT `fk_oauthRefreshToken_sessionId_session_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `session`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_oauthRefreshToken_userId_user_id_fk` FOREIGN KEY (`userId`) REFERENCES `user`(`id`)
);

CREATE TABLE `oauthResource` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`accessTokenTtl` integer,
	`refreshTokenTtl` integer,
	`signingAlgorithm` text,
	`signingKeyId` text,
	`allowedScopes` text,
	`customClaims` text,
	`dpopBoundAccessTokensRequired` integer DEFAULT 0,
	`disabled` integer DEFAULT 0,
	`createdAt` date,
	`updatedAt` date,
	`policyVersion` integer DEFAULT 1,
	`metadata` text
);

CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` date NOT NULL,
	`token` text NOT NULL UNIQUE,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	CONSTRAINT `fk_session_userId_user_id_fk` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE
);

CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`emailVerified` integer NOT NULL,
	`image` text,
	`isAnonymous` integer DEFAULT 0,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL
);

CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` date NOT NULL,
	`createdAt` date NOT NULL,
	`updatedAt` date NOT NULL
);

CREATE INDEX `wildwoodAccessGrant_subject_idx` ON `wildwood_access_grant` (`project_id`,`subject_type`,`subject_id`);
CREATE INDEX `wildwoodAccessGrant_parent_idx` ON `wildwood_access_grant` (`parent_grant_id`);
CREATE UNIQUE INDEX `wildwoodAccessGrant_owner_uidx` ON `wildwood_access_grant` (`project_id`) WHERE "wildwood_access_grant"."kind" = 'owner';
CREATE INDEX `wildwoodApproval_status_idx` ON `wildwood_approval_request` (`project_id`,`status`);
CREATE INDEX `wildwoodAuthEvent_created_idx` ON `wildwood_auth_event` (`project_id`,`created_at`);
CREATE INDEX `wildwoodCredential_subject_idx` ON `wildwood_credential` (`project_id`,`subject_type`,`subject_id`);
CREATE UNIQUE INDEX `wildwoodCredential_secretHash_uidx` ON `wildwood_credential` (`secret_hash`);
CREATE UNIQUE INDEX `wildwoodProject_name_uidx` ON `wildwood_project` (`provider`,`org_name`,`repo_name`);
CREATE UNIQUE INDEX `wildwoodProject_external_uidx` ON `wildwood_project` (`provider`,`external_id`) WHERE "wildwood_project"."external_id" is not null;
CREATE INDEX `account_userId_idx` ON `account` (`userId`);
CREATE INDEX `deviceCode_deviceCode_idx` ON `deviceCode` (`deviceCode`);
CREATE INDEX `deviceCode_userCode_idx` ON `deviceCode` (`userCode`);
CREATE INDEX `oauthAccessToken_authorizationCodeId_idx` ON `oauthAccessToken` (`authorizationCodeId`);
CREATE INDEX `oauthAccessToken_clientId_idx` ON `oauthAccessToken` (`clientId`);
CREATE INDEX `oauthAccessToken_sessionId_idx` ON `oauthAccessToken` (`sessionId`);
CREATE INDEX `oauthAccessToken_userId_idx` ON `oauthAccessToken` (`userId`);
CREATE INDEX `oauthAccessToken_refreshId_idx` ON `oauthAccessToken` (`refreshId`);
CREATE INDEX `oauthClient_userId_idx` ON `oauthClient` (`userId`);
CREATE INDEX `oauthClientResource_clientId_idx` ON `oauthClientResource` (`clientId`);
CREATE INDEX `oauthClientResource_resourceId_idx` ON `oauthClientResource` (`resourceId`);
CREATE INDEX `oauthConsent_clientId_idx` ON `oauthConsent` (`clientId`);
CREATE INDEX `oauthConsent_userId_idx` ON `oauthConsent` (`userId`);
CREATE INDEX `oauthRefreshToken_clientId_idx` ON `oauthRefreshToken` (`clientId`);
CREATE INDEX `oauthRefreshToken_sessionId_idx` ON `oauthRefreshToken` (`sessionId`);
CREATE INDEX `oauthRefreshToken_authorizationCodeId_idx` ON `oauthRefreshToken` (`authorizationCodeId`);
CREATE INDEX `oauthRefreshToken_userId_idx` ON `oauthRefreshToken` (`userId`);
CREATE INDEX `session_userId_idx` ON `session` (`userId`);
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);
