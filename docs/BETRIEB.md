# Betrieb der Instanz nomocase.example.org

Notizen für den Betrieb dieser einen Installation. Allgemeines zur Installation steht im [README](../README.md#betrieb).

Live unter https://nomocase.example.org (workers.dev ist abgeschaltet: Passkeys hängen an der Domain). Die frühere Domain
nomocase-old.example.org leitet dauerhaft dorthin um (`REDIRECT_HOSTS`); dort angelegte Passkeys gelten auf der neuen Domain nicht.
D1 und R2 liegen in der EU-Jurisdiktion. Der Token liegt in `nomocase.token.cloudflare.credential` (gitignored).
E-Mails gehen über Resend (Domain `nomocase.example.org`, Region EU, Absender `noreply@nomocase.example.org`);
der Sende-Key liegt in `resend.credential` und als Worker-Secret `RESEND_API_KEY`. Ohne Key werden Einladungslinks
angezeigt und die tägliche Übersicht (Cron 05:00 UTC) pausiert.

```sh
export CLOUDFLARE_API_TOKEN=$(tr -d '[:space:]' < nomocase.token.cloudflare.credential)
npx wrangler d1 migrations apply nomocase --remote   # nur bei neuen Migrationen
npx wrangler deploy
BASE=https://nomocase.example.org EMAIL=<owner> node test/passkey.mjs   # Check gegen Produktion
npm run login-link -- <email> --remote                                     # Recovery
tr -d "[:space:]" < resend.credential | npx wrangler secret put RESEND_API_KEY   # Mail-Key (erledigt)
```

Erstinstallation (erledigt): `wrangler d1 create nomocase --jurisdiction eu`, `wrangler r2 bucket create nomocase-files --jurisdiction eu`,
Migrationen + `seed.sql` remote, danach Owner-Konto `u_prof` per `UPDATE users` auf die echte E-Mail gesetzt.

## Vorlagen und Erscheinungsbild

- Beispielvorlagen veröffentlichen: `npm run templates -- --remote` (legt nur neue Versionen an, wenn sich etwas geändert hat;
  in der Oberfläche gespeicherte Versionen werden nicht überschrieben, außer mit `--force`).
- Logo und Akzentfarbe der Formulare: Workspace-Seite → „Erscheinungsbild der Formulare“ (Workspace „Hochschule“: HSD-Logo, Rot #e60028).

## Mail in Vorgänge

Cloudflare Email Routing für `example.org`, Catch-all → Worker `nomocase`; die Adressdomain steht in `INBOX_DOMAIN`.
