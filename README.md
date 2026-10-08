# Mongoster

Estensione VS Code per navigare MongoDB: apri le collezioni in tabella, ispeziona i documenti come JSON e costruisci i filtri trascinando celle e colonne.

## Funzionalità

- **Connessioni** nella barra laterale (icona a foglia): connessione → database → collezioni. Le connection string sono salvate nel SecretStorage di VS Code.
- **Tabella** per collezione: una colonna per campo, valori colorati per tipo, paginazione, conteggio totale.
- **Filter / Sort / Project** in sintassi mongosh: `{ _id: ObjectId("…"), name: /mario/i, createdAt: { $gte: ISODate("2024-01-01") } }`. `Ctrl+Enter` esegue.
- **Drag & drop verso il filtro**:
  - trascina una **cella** → `= equals`, `≠ not equal`, e per numeri/date/stringhe `≥ from` / `≤ to` (si combinano in un range sullo stesso campo); per gli array `∈ in`;
  - trascina l'**intestazione di una colonna** → `exists`, `missing`, `is null`.
- **Cronologia query**: `History` nella toolbar mostra le query salvate con un nome e le ultime 50 eseguite con successo su quella collezione (senza duplicati, ricordate anche chiudendo VS Code). Clic o `Invio` per rieseguirne una; ricerca, `☆` per salvarla con un nome, `✕` per toglierla, `Clear` per svuotare le recenti.
- **Ordinamento**: clic sull'intestazione (▲ → ▼ → nessuno).
- **Colonne annidate**: le colonne con sotto-documenti hanno un pulsante `▸` che le espande in colonne con il punto (`address` → `address.city`, `address.zip`, …), un livello alla volta; `Alt+clic` espande tutti i livelli. Clic sul prefisso (`address.`) per richiudere il gruppo. Filtri, range e ordinamento funzionano anche sui campi annidati (`{ "address.city": "Milano" }`). Se in un documento il campo non è un oggetto, il valore occupa tutto il gruppo. Le espansioni sono ricordate per ogni collezione.
- **Documento JSON**: doppio clic su una riga (o clic sul numero di riga) apre una dialog con l'albero JSON espandibile; `↑/↓` per scorrere i documenti, `Copy`.
- **Modifica**: `Edit` apre il documento in una tab dell'editor; `Ctrl+S` lo salva su MongoDB.
  - I tipi numerici restano quelli originali (Double, Int32, Long), anche cambiando il valore; `NumberLong(...)` e simili forzano un tipo esplicito.
  - Nell'editor è accettata anche la sintassi mongosh (`ObjectId(...)`, `ISODate(...)`).
  - Se il documento è stato modificato o cancellato nel database dopo l'apertura, viene chiesto se sovrascrivere / reinserire.
  - `_id` non si può cambiare: usa `Duplicate`.
- **Insert / Duplicate / Delete**: `Insert` nella toolbar (o `+` sulla collezione nell'albero) apre un nuovo documento da salvare con `Ctrl+S`; `Duplicate` ne apre una copia senza `_id`; `Delete` (o il tasto `Canc` su una cella) elimina dopo conferma.
- Le **view** sono in sola lettura.
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
- `src/queryHistory.ts` – cronologia e query salvate per collezione
- `src/documentFs.ts` – file system virtuale `mongoster://` per aprire, modificare e salvare i documenti
- `src/shared/query.ts` – parsing/formattazione della sintassi mongosh ⇄ EJSON
- `src/webview/main.ts`, `src/webview/columns.ts`, `src/webview/history.ts`, `media/webview.css` – UI della tabella e modello delle colonne
