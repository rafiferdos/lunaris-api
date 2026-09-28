CREATE FUNCTION lunaris_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable event/snapshot cannot be updated' USING ERRCODE='23514'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER xp_immutable BEFORE UPDATE ON xp_ledger FOR EACH ROW EXECUTE FUNCTION lunaris_reject_update();
--> statement-breakpoint
CREATE TRIGGER rating_immutable BEFORE UPDATE ON rating_events FOR EACH ROW EXECUTE FUNCTION lunaris_reject_update();
--> statement-breakpoint
CREATE TRIGGER snapshot_immutable BEFORE UPDATE ON attempt_questions FOR EACH ROW EXECUTE FUNCTION lunaris_reject_update();
--> statement-breakpoint
CREATE TRIGGER audit_immutable BEFORE UPDATE ON admin_audit_logs FOR EACH ROW EXECUTE FUNCTION lunaris_reject_update();
--> statement-breakpoint
CREATE FUNCTION lunaris_question_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.content IS DISTINCT FROM OLD.content OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.question_key IS DISTINCT FROM OLD.question_key OR NEW.version IS DISTINCT FROM OLD.version OR NEW.topic_id IS DISTINCT FROM OLD.topic_id OR NEW.difficulty IS DISTINCT FROM OLD.difficulty THEN
 RAISE EXCEPTION 'Create a new question version instead of changing existing content' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER question_immutable BEFORE UPDATE ON questions FOR EACH ROW EXECUTE FUNCTION lunaris_question_immutable();
--> statement-breakpoint
CREATE FUNCTION lunaris_final_result_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status <> 'IN_PROGRESS' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Finalized attempts are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER finalized_attempt_immutable BEFORE UPDATE ON attempts FOR EACH ROW EXECUTE FUNCTION lunaris_final_result_immutable();
--> statement-breakpoint
ALTER TABLE questions ADD CONSTRAINT question_content_identity CHECK(content->>'questionKey'=question_key AND (content->>'version')::int=version AND content->>'difficulty'=difficulty::text AND jsonb_array_length(content->'options') BETWEEN 2 AND 8);
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT user_role_valid CHECK(role IN ('USER','ADMIN'));
