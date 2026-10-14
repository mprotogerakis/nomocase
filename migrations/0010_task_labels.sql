-- Own button labels for decision tasks, e.g. ["Bestanden", "Nicht bestanden"] instead of "Genehmigen" / "Ablehnen".
ALTER TABLE tasks ADD COLUMN labels TEXT;
