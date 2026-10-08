# Mongoster

Estensione VS Code per navigare MongoDB: apri le collezioni in tabella, ispeziona i documenti come JSON e costruisci i filtri trascinando celle e colonne.

## Funzionalità

- **Connessioni** nella barra laterale (icona a foglia): connessione → database → collezioni. Le connection string sono salvate nel SecretStorage di VS Code.
  - `Edit Connection…` cambia connection string e nome (una nuova connection string viene provata prima di salvarla); `Copy Connection String` la copia negli appunti.
  - **Cartelle**: `Move to Folder…` raggruppa le connessioni (anche in una cartella nuova); sulla cartella `+` aggiunge una connessione lì dentro, `Rename Folder…` la rinomina, `Remove Folder` la toglie lasciando le connessioni.
  - **Colore**: `Set Color…` (rosso, arancione, giallo, verde, blu, viola) colora l'icona nell'albero e aggiunge una striscia colorata in cima alle tab delle sue collezioni, per esempio rosso per la produzione.
  - **Sola lettura**: `Make Read-Only` impedisce a Mongoster qualsiasi scrittura tramite quella connessione (modifica, insert, delete, update/delete many, import, indici, `$out`/`$merge`, creazione/rinomina/eliminazione di database e collezioni); query, aggregate, schema, explain ed export restano disponibili. `Allow Changes` la riabilita dopo conferma. È una protezione dell'estensione: i permessi veri restano quelli dell'utente MongoDB.
  - Nome, colore e sola lettura si applicano subito alle tab già aperte.
- **Gestione database e collezioni** dal menu contestuale dell'albero:
  - `Create Database…` sulla connessione chiede il nome del database e della prima collezione (MongoDB crea un database solo insieme a una collezione) e la apre.
  - `Create Collection…` (anche con `+` sul database) accetta opzioni facoltative, per esempio `{ capped: true, size: 1048576 }` o `{ timeseries: { timeField: "ts" } }`.
  - `Rename Collection…` rinomina nello stesso database; la tab aperta, la cronologia delle query e le colonne espanse seguono il nuovo nome. Le view non si rinominano.
  - `Drop…` su collezioni e view, `Drop Database…` sul database: per collezioni e database va digitato il nome per confermare, e il messaggio dice quanti documenti, indici o collezioni verranno eliminati. Le tab delle collezioni eliminate si chiudono.
- **Tabella** per collezione: una colonna per campo, valori colorati per tipo, paginazione, conteggio totale.
- **Filter / Sort / Project** in sintassi mongosh: `{ _id: ObjectId("…"), name: /mario/i, createdAt: { $gte: ISODate("2024-01-01") } }`. `Ctrl+Enter` esegue.
- **Drag & drop verso il filtro**:
  - trascina una **cella** → `= equals`, `≠ not equal`, e per numeri/date/stringhe `≥ from` / `≤ to` (si combinano in un range sullo stesso campo); per gli array `∈ in`;
  - trascina l'**intestazione di una colonna** → `exists`, `missing`, `is null`.
- **Cronologia query**: `History` nella toolbar mostra le query salvate con un nome e le ultime 50 eseguite con successo su quella collezione (senza duplicati, ricordate anche chiudendo VS Code). Clic o `Invio` per rieseguirne una; ricerca, `☆` per salvarla con un nome, `✕` per toglierla, `Clear` per svuotare le recenti.
- **Ordinamento**: clic sull'intestazione (▲ → ▼ → nessuno).
- **Colonne personalizzabili**, ricordate per ogni collezione (anche dopo una rinomina):
  - **nascondere**: clic destro sull'intestazione → `Hide`, oppure le checkbox del pannello `Columns` nella barra sopra la tabella (con ricerca, `Show all` e `Reset`);
  - **riordinare**: trascina un'intestazione su un'altra (la colonna va prima o dopo, tra quelle dello stesso livello), oppure trascina le righe nel pannello `Columns`;
  - **ridimensionare**: trascina il bordo destro dell'intestazione; doppio clic sul bordo per tornare alla larghezza automatica;
  - **fissare a sinistra**: clic destro → `Pin`, oppure `📌` nel pannello: la colonna resta visibile scorrendo in orizzontale.
  - L'export CSV usa le colonne visibili nell'ordine scelto.
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
- **Update many / Delete many**: i pulsanti accanto a `Explain` agiscono su tutti i documenti che corrispondono al filtro.
  - La dialog mostra il filtro e quanti documenti corrispondono prima di scrivere; la tabella dietro mostra quei documenti.
  - Per l'update si scrivono gli operatori (`{ $set: { status: "archived" }, $inc: { version: 1 } }`) o una pipeline (`[ { $set: { total: { $add: ["$a", "$b"] } } } ]`); un documento senza operatori viene rifiutato perché sostituirebbe i documenti interi. `Ctrl+Invio` applica.
  - Con il filtro vuoto viene chiesta un'ulteriore conferma, perché si modifica o cancella l'intera collezione.
  - Al termine viene mostrato quanti documenti sono stati modificati o eliminati. Non disponibile per le view.
- **Modifica inline**: doppio clic su una cella (o `F2` sulla cella selezionata) per modificarne il valore in sintassi mongosh; `Invio` salva con `$set`, `Shift+Invio` va a capo, `Esc` (o un clic altrove) annulla.
  - Funziona anche sui campi annidati, sugli elementi degli array espansi (`items.2.qty`) e sulle celle vuote (aggiunge il campo).
  - I tipi numerici restano quelli originali; `NumberLong(...)` e simili forzano un tipo.
  - Se nel frattempo il valore è cambiato nel database viene chiesto se sovrascrivere. Non disponibile per `_id`, per le view e in modalità Aggregate.
- **Documento JSON**: clic sul numero di riga (o `Invio` sulla cella selezionata) apre una dialog con l'albero JSON espandibile; `↑/↓` per scorrere i documenti, `Copy`.
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
- **Schema**: la scheda `Schema` analizza i documenti che corrispondono al filtro (tutti, o un campione casuale di 100 / 1.000 / 10.000) e per ogni campo mostra:
  - quanto spesso è presente e con quali tipi BSON (`int`, `double`, `long`, `decimal`, `date`, `objectId`, …), con le percentuali;
  - i valori più frequenti, oppure un istogramma per numeri e date con minimo e massimo; per gli array la lunghezza e i valori degli elementi.
  - I sotto-documenti e i campi degli oggetti negli array (`items[].sku`) si espandono con `▸`; `⊞` / `⊟` espandono o chiudono tutto.
  - Clic su un valore, su una barra dell'istogramma o su un tipo per aggiungerlo al filtro (`{ status: "active" }`, `{ age: { $gte: 25, $lt: 30 } }`, `{ name: { $type: "string" } }`): l'analisi riparte sui documenti filtrati.
- **Indici**: la scheda `Indexes` (accanto a `Find / Aggregate`) elenca gli indici della collezione con chiavi, proprietà (`unique`, `sparse`, TTL, `partial`, `text`, `hidden`, …), dimensione e numero di utilizzi dall'avvio del server.
  - Per creare un indice scrivi le chiavi (`{ status: 1, createdAt: -1 }`) e, se servono, le opzioni (`{ unique: true, expireAfterSeconds: 3600, partialFilterExpression: { … } }`), poi `Create`.
  - `Hide` nasconde un indice al query planner senza cancellarlo (utile per capire se serve ancora), `Unhide` lo riattiva; `Drop` lo elimina dopo conferma. `_id_` non si può toccare.
  - Le view non hanno indici propri: usano quelli della collezione di origine.
- **Explain**: il pulsante `Explain` (in `Find` e nell'editor della pipeline) mostra come MongoDB esegue la query: indice usato o `COLLSCAN`, ordinamento in memoria, documenti e chiavi esaminati rispetto a quelli restituiti, tempo, piano di esecuzione a albero; `Raw` mostra l'output completo.
  - Se la query legge tutta la collezione o ordina in memoria propone un indice (prima i campi in uguaglianza, poi l'ordinamento, poi i range); `Create…` apre la scheda `Indexes` con l'indice già compilato.
  - Per le pipeline spiega fino allo stage mostrato; quelle con `$out`/`$merge` non si spiegano.
- Le **view** sono in sola lettura, come le collezioni delle connessioni in sola lettura (badge `view` / `read-only` accanto al nome).
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
- `src/manage.ts` – creazione, rinomina ed eliminazione di database e collezioni
- `src/shared/query.ts` – parsing/formattazione della sintassi mongosh ⇄ EJSON
- `src/shared/columns.ts` – modello delle colonne (annidate e array) e del layout scelto dall'utente, usato dalla tabella e dal CSV
- `src/shared/csv.ts` – generazione e parsing CSV
- `src/shared/pipeline.ts` – modello degli stage di aggregazione, modelli e conversione testo ⇄ stage
- `src/shared/explain.ts` – riassunto dell'output di explain e suggerimento dell'indice
- `src/shared/schema.ts` – analisi dello schema di un campione di documenti
- `src/webview/main.ts`, `src/webview/history.ts`, `src/webview/pipeline.ts`, `src/webview/indexes.ts`, `src/webview/explainView.ts`, `src/webview/bulk.ts`, `src/webview/schemaView.ts`, `src/webview/columnsUi.ts`, `media/webview.css` – UI della tabella, cronologia, editor della pipeline, indici, explain, update/delete many, schema e colonne
