-- CreateTable
CREATE TABLE `knowledge_versions` (
    `id` CHAR(36) NOT NULL,
    `pack_name` VARCHAR(100) NOT NULL,
    `pack_version` VARCHAR(50) NOT NULL,
    `content_hash` CHAR(64) NOT NULL,
    `status` ENUM('active', 'archived', 'failed') NOT NULL,
    `pack_snapshot` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `knowledge_versions_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_state` (
    `id` INTEGER NOT NULL,
    `active_version_id` CHAR(36) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `knowledge_chunks` (
    `version_id` CHAR(36) NOT NULL,
    `id` VARCHAR(100) NOT NULL,
    `module` VARCHAR(100) NOT NULL,
    `kind` ENUM('regulation', 'how_to') NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `section` VARCHAR(200) NOT NULL,
    `text` TEXT NOT NULL,
    `tags` JSON NOT NULL,
    `updated_at` VARCHAR(10) NOT NULL,
    `content_hash` CHAR(64) NOT NULL,

    PRIMARY KEY (`version_id`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `faqs` (
    `version_id` CHAR(36) NOT NULL,
    `id` VARCHAR(100) NOT NULL,
    `intent` VARCHAR(30) NOT NULL,
    `summary` VARCHAR(500) NOT NULL,
    `applies_when` TEXT NOT NULL,
    `answer` TEXT NOT NULL,
    `source_chunk_id` VARCHAR(100) NULL,

    PRIMARY KEY (`version_id`, `id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `faq_variants` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `version_id` CHAR(36) NOT NULL,
    `faq_id` VARCHAR(100) NOT NULL,
    `text` VARCHAR(1000) NOT NULL,

    INDEX `faq_variants_version_id_faq_id_idx`(`version_id`, `faq_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_sessions` (
    `id` CHAR(36) NOT NULL,
    `user_id` VARCHAR(100) NOT NULL,
    `channel` VARCHAR(50) NOT NULL,
    `next_turn_seq` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_active_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `chat_sessions_user_id_last_active_at_idx`(`user_id`, `last_active_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_turns` (
    `id` CHAR(36) NOT NULL,
    `session_id` CHAR(36) NOT NULL,
    `turn_seq` INTEGER NOT NULL,
    `client_msg_id` CHAR(36) NOT NULL,
    `user_text` TEXT NOT NULL,
    `retry_of_turn_seq` INTEGER NULL,
    `status` ENUM('processing', 'completed', 'failed') NOT NULL,
    `error_code` VARCHAR(40) NULL,
    `error_retryable` BOOLEAN NULL,
    `assistant_text` TEXT NULL,
    `route` VARCHAR(20) NULL,
    `sources` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completed_at` DATETIME(3) NULL,

    INDEX `chat_turns_status_idx`(`status`),
    INDEX `chat_turns_created_at_idx`(`created_at`),
    UNIQUE INDEX `chat_turns_session_id_turn_seq_key`(`session_id`, `turn_seq`),
    UNIQUE INDEX `chat_turns_session_id_client_msg_id_key`(`session_id`, `client_msg_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_traces` (
    `id` CHAR(36) NOT NULL,
    `turn_id` CHAR(36) NOT NULL,
    `knowledge_version_id` CHAR(36) NOT NULL,
    `template_version` VARCHAR(20) NOT NULL,
    `model_version` VARCHAR(40) NULL,
    `route` VARCHAR(20) NOT NULL,
    `intent` VARCHAR(30) NULL,
    `in_scope` DOUBLE NULL,
    `ambiguity` DOUBLE NULL,
    `faq_choice` VARCHAR(100) NULL,
    `faq_prob` DOUBLE NULL,
    `faq_confidence` DOUBLE NULL,
    `b_status` VARCHAR(20) NOT NULL,
    `total_input_tokens` INTEGER NOT NULL,
    `error_code` VARCHAR(40) NULL,
    `data` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `message_traces_turn_id_key`(`turn_id`),
    INDEX `message_traces_route_created_at_idx`(`route`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_reviews` (
    `id` CHAR(36) NOT NULL,
    `trace_id` CHAR(36) NOT NULL,
    `verdict` ENUM('correct', 'wrong', 'partial') NOT NULL,
    `expected_intent` VARCHAR(30) NULL,
    `expected_faq_id` VARCHAR(100) NULL,
    `expected_chunk_ids` JSON NULL,
    `note` TEXT NULL,
    `reviewer_id` VARCHAR(100) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `knowledge_chunks` ADD CONSTRAINT `knowledge_chunks_version_id_fkey` FOREIGN KEY (`version_id`) REFERENCES `knowledge_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `faqs` ADD CONSTRAINT `faqs_version_id_fkey` FOREIGN KEY (`version_id`) REFERENCES `knowledge_versions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `faqs` ADD CONSTRAINT `faqs_version_id_source_chunk_id_fkey` FOREIGN KEY (`version_id`, `source_chunk_id`) REFERENCES `knowledge_chunks`(`version_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `faq_variants` ADD CONSTRAINT `faq_variants_version_id_faq_id_fkey` FOREIGN KEY (`version_id`, `faq_id`) REFERENCES `faqs`(`version_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chat_turns` ADD CONSTRAINT `chat_turns_session_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `message_traces` ADD CONSTRAINT `message_traces_turn_id_fkey` FOREIGN KEY (`turn_id`) REFERENCES `chat_turns`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `message_reviews` ADD CONSTRAINT `message_reviews_trace_id_fkey` FOREIGN KEY (`trace_id`) REFERENCES `message_traces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
