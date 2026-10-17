-- A closed case is read-only: nothing in it changes until it is reopened (and that is logged). Enforced here, in each
-- write's own transaction, so no way around it is left: steps, phases, documents and their versions and signatures,
-- money, upload links, the case's fields, definition (rules) and title, and comments. Not affected: closing and
-- reopening, access (participants, invitations), moving the case, and deleting it – the tombstone in case_deletions,
-- written first in the same transaction, lets the deletion through (as for the append-only events).

CREATE TRIGGER tasks_closed_insert BEFORE INSERT ON tasks
  WHEN (SELECT status FROM cases WHERE id = NEW.case_id) = 'closed' AND NEW.case_id NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER tasks_closed_update BEFORE UPDATE ON tasks
  WHEN (SELECT status FROM cases WHERE id = OLD.case_id) = 'closed' AND OLD.case_id NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER tasks_closed_delete BEFORE DELETE ON tasks
  WHEN (SELECT status FROM cases WHERE id = OLD.case_id) = 'closed' AND OLD.case_id NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER phases_closed_insert BEFORE INSERT ON phases
  WHEN (SELECT status FROM cases WHERE id = NEW.case_id) = 'closed' AND NEW.case_id NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER phases_closed_update BEFORE UPDATE ON phases
  WHEN (SELECT status FROM cases WHERE id = OLD.case_id) = 'closed' AND OLD.case_id NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER phases_closed_delete BEFORE DELETE ON phases
  WHEN (SELECT status FROM cases WHERE id = OLD.case_id) = 'closed' AND OLD.case_id NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER documents_closed_insert BEFORE INSERT ON documents
  WHEN (SELECT status FROM cases WHERE id = NEW.case_id) = 'closed' AND NEW.case_id NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER documents_closed_update BEFORE UPDATE ON documents
  WHEN (SELECT status FROM cases WHERE id = OLD.case_id) = 'closed' AND OLD.case_id NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER documents_closed_delete BEFORE DELETE ON documents
  WHEN (SELECT status FROM cases WHERE id = OLD.case_id) = 'closed' AND OLD.case_id NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER document_versions_closed_insert BEFORE INSERT ON document_versions
  WHEN (SELECT status FROM cases WHERE id = (SELECT case_id FROM documents WHERE id = NEW.document_id)) = 'closed' AND (SELECT case_id FROM documents WHERE id = NEW.document_id) NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER document_versions_closed_delete BEFORE DELETE ON document_versions
  WHEN (SELECT status FROM cases WHERE id = (SELECT case_id FROM documents WHERE id = OLD.document_id)) = 'closed' AND (SELECT case_id FROM documents WHERE id = OLD.document_id) NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER document_signatures_closed_insert BEFORE INSERT ON document_signatures
  WHEN (SELECT status FROM cases WHERE id = (SELECT d.case_id FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = NEW.version_id)) = 'closed' AND (SELECT d.case_id FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = NEW.version_id) NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER financial_claims_closed_insert BEFORE INSERT ON financial_claims
  WHEN (SELECT status FROM cases WHERE id = NEW.case_id) = 'closed' AND NEW.case_id NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER financial_decisions_closed_insert BEFORE INSERT ON financial_decisions
  WHEN (SELECT status FROM cases WHERE id = (SELECT case_id FROM financial_claims WHERE id = NEW.claim_id)) = 'closed' AND (SELECT case_id FROM financial_claims WHERE id = NEW.claim_id) NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER financial_transactions_closed_insert BEFORE INSERT ON financial_transactions
  WHEN (SELECT status FROM cases WHERE id = (SELECT case_id FROM financial_claims WHERE id = NEW.claim_id)) = 'closed' AND (SELECT case_id FROM financial_claims WHERE id = NEW.claim_id) NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER upload_links_closed_insert BEFORE INSERT ON upload_links
  WHEN (SELECT status FROM cases WHERE id = NEW.case_id) = 'closed' AND NEW.case_id NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER events_closed_comment BEFORE INSERT ON events
  WHEN NEW.type = 'comment' AND (SELECT status FROM cases WHERE id = NEW.case_id) = 'closed' AND NEW.case_id NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
CREATE TRIGGER cases_closed_update BEFORE UPDATE OF fields, definition, title ON cases
  WHEN OLD.status = 'closed' AND NEW.status = 'closed'
  BEGIN SELECT RAISE(ABORT, 'case closed'); END;
