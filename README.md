# Mongoster

Estensione VS Code per navigare MongoDB: apri le collezioni in tabella, ispeziona i documenti come JSON e costruisci i filtri trascinando celle e colonne.

## Funzionalità

- **Connessioni** nella barra laterale (icona a foglia): connessione → database → collezioni. Le connection string sono salvate nel SecretStorage di VS Code.
- **Tabella** per collezione: una colonna per campo, valori colorati per tipo, paginazione, conteggio totale.
- **Filter / Sort / Project** in sintassi mongosh: `{ _id: ObjectId("…"), name: /mario/i, createdAt: { $gte: ISODate("2024-01-01") } }`. `Ctrl+Enter` esegue.
- **Drag & drop verso il filtro**:
  - trascina una **cella** → `= equals`, `≠ not equal`, e per numeri/date/stringhe `≥ from` / `≤ to` (si combinano in un range sullo stesso campo); per gli array `∈ in`;
  - trascina l'**intestazione di una colonna** → `exists`, `missing`, `is null`.
- **Ordinamento**: clic sull'intestazione (▲ → ▼ → nessuno).
- **Documento JSON**: doppio clic su una riga (o clic sul numero di riga) apre una dialog con l'albero JSON espandibile; `↑/↓` per scorrere i documenti, `Copy`, `Open in editor` (tab JSON di sola lettura).
- `Ctrl+C` su una cella selezionata copia il valore.

## Sviluppo

```bash
npm install
npm run build      # oppure: npm run watch
```

Premi **F5** in VS Code ("Run Mongoster") per aprire una finestra Extension Development Host.

Per creare un pacchetto installabile:

```bash
npm run package    # genera mongoster-<versione>.vsix
code --install-extension mongoster-0.0.1.vsix
```

## Struttura

- `src/extension.ts` – attivazione e comandi
- `src/connections.ts` – connessioni salvate e cache dei `MongoClient`
- `src/tree.ts` – albero connessioni/database/collezioni
- `src/collectionPanel.ts` – webview per collezione, esecuzione delle query
- `src/documentProvider.ts` – documenti JSON di sola lettura nell'editor
- `src/shared/query.ts` – parsing/formattazione della sintassi mongosh ⇄ EJSON
- `src/webview/main.ts`, `media/webview.css` – UI della tabella
