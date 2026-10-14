-- What an uploaded form says about the case's fields (form key, title, field key → value), read on upload.
ALTER TABLE document_versions ADD COLUMN form_values TEXT;
