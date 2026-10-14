-- Money words moved from the code into templates (finance.labels). Running cases of the medical-invoice template keep
-- the words they were shown with so far; all other cases get the neutral defaults.
UPDATE cases SET definition = json_set(definition, '$.finance', json('{"labels": {"payable": "Rechnung", "receivable": "Erstattung", "received": "Erstattet", "receivables_open": "Offene Erstattungen", "balance": "Eigenanteil bisher", "add": "Forderung oder Erstattung"}}'))
WHERE template_id = 'tpl_med' AND json_type(definition, '$.finance') = 'true';
