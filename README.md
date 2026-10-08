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
- **Aggregate**: il selettore `Find / Aggregate` in alto passa all'editor di pipeline.
  - Ogni stage è una scheda: operatore (con suggerimenti e un modello per gli stage comuni), corpo in sintassi mongosh, checkbox per disattivarlo, `‹ ›` per spostarlo, `✕` per toglierlo. `Ctrl+Enter` in uno stage esegue.
  - Clic sul **numero di uno stage** mostra l'output fino a quello stage (con paginazione e conteggio); gli stage successivi vengono attenuati. `Run` esegue la pipeline intera.
  - Il drag & drop funziona anche qui: la condizione va nel `$match` mostrato, oppure in un nuovo `$match` subito dopo lo stage mostrato. Il clic sull'intestazione aggiunge o modifica uno `$sort` nello stesso punto.
  - `Edit as text` per incollare o modificare l'intera pipeline (`[ { $match: … }, … ]`), `Copy` per copiarla.
  - Gli stage che scrivono (`$out`, `$merge`) chiedono conferma prima di eseguire; l'anteprima di uno stage precedente non scrive nulla.
  - Gli errori indicano lo stage che li ha causati. Le pipeline finiscono nella stessa cronologia delle query.
  - I risultati dell'aggregate non sono modificabili: per modificare un documento torna a `Find`.
- **Colonne annidate**: le colonne con sotto-documenti hanno un pulsante `▸` che le espande in colonne con il punto (`address` → `address.city`, `address.zip`, …), un livello alla volta; `Alt+clic` espande tutti i livelli. Clic sul prefisso (`address.`) per richiudere il gruppo. Filtri, range e ordinamento funzionano anche sui campi annidati (`{ "address.city": "Milano" }`). Se in un documento il campo non è un oggetto, il valore occupa tutto il gruppo. Le espansioni sono ricordate per ogni collezione.
- **Array di oggetti**: anche le colonne con array di sotto-documenti hanno `▸[]`: si espandono nei campi degli elementi (`items[].sku`, `items[].qty`, …) e **ogni elemento diventa una sotto-riga** del documento, così i campi dello stesso elemento restano allineati (fino a 20 elementi per documento, poi `… N more`).
  - Trascinando il valore di un elemento il filtro usa `$elemMatch`: `{ items: { $elemMatch: { sku: "A1", qty: { $gte: 4 } } } }`. Più condizioni sullo stesso array si sommano nello stesso `$elemMatch`, quindi valgono per lo **stesso elemento**.
  - Trascinare l'intestazione e ordinare usano il percorso puntato (`items.sku`).
  - Dentro gli elementi si possono espandere i sotto-documenti (`items[].options.color`); gli array dentro gli array restano come valore.
- **Documento JSON**: doppio clic su una riga (o clic sul numero di riga) apre una dialog con l'albero JSON espandibile; `↑/↓` per scorrere i documenti, `Copy`.
- **Modifica**: `Edit` apre il documento in una tab dell'editor; `Ctrl+S` lo salva su MongoDB.
  - I tipi numerici restano quelli originali (Double, Int32, Long), anche cambiando il valore; `NumberLong(...)` e simili forzano un tipo esplicito.
  - Nell'editor è accettata anche la sintassi mongosh (`ObjectId(...)`, `ISODate(...)`).
  - Se il documento è stato modificato o cancellato nel database dopo l'apertura, viene chiesto se sovrascrivere / reinserire.
  - `_id` non si può cambiare: usa `Duplicate`.
- **Insert / Duplicate / Delete**: `Insert` nella toolbar (o `+` sulla collezione nell'albero) apre un nuovo documento da salvare con `Ctrl+S`; `Duplicate` ne apre una copia senza `_id`; `Delete` (o il tasto `Canc` su una cella) elimina dopo conferma.
- **Export**: il pulsante `Export` esporta ciò che mostra la tabella (la query, oppure la pipeline fino allo stage mostrato): tutti i risultati o solo la pagina corrente. Anche dall'albero: clic destro su una collezione o view → `Export Collection…`.
  - **JSON**: array leggibile (Extended JSON rilassato).
  - **JSON Lines**: un documento per riga in Extended JSON canonico, conserva tutti i tipi; è il formato giusto per reimportare.
  - **CSV**: le colonne visibili (anche quelle espanse); gli array espansi danno una riga per elemento con gli altri valori ripetuti. Con BOM UTF-8, così Excel legge gli accenti.
  - Le pipeline che finiscono con `$out`/`$merge` non si esportano: seleziona uno stage precedente.
- **Import**: clic destro su una collezione → `Import Documents…` accetta JSON (array o singolo documento), JSON Lines, CSV e anche la sintassi mongosh (`ObjectId(...)`, `ISODate(...)`). Chiede conferma, inserisce a blocchi di 1000 e segnala i documenti scartati (es. `_id` già esistente) senza fermarsi.
  - Nel CSV le intestazioni con il punto creano sotto-documenti (`address.city`), le celle vuote vengono omesse e numeri, booleani, `null`, date ISO (`…Z`), JSON e `_id` esadecimali vengono riconosciuti.
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
- `src/queries.ts` – testo di filtri e pipeline → argomenti del driver
- `src/transfer.ts` – export (JSON, JSON Lines, CSV) e import
- `src/shared/query.ts` – parsing/formattazione della sintassi mongosh ⇄ EJSON
- `src/shared/columns.ts` – modello delle colonne (annidate e array), usato dalla tabella e dal CSV
- `src/shared/csv.ts` – generazione e parsing CSV
- `src/shared/pipeline.ts` – modello degli stage di aggregazione, modelli e conversione testo ⇄ stage
- `src/webview/main.ts`, `src/webview/history.ts`, `src/webview/pipeline.ts`, `media/webview.css` – UI della tabella, cronologia ed editor della pipeline
