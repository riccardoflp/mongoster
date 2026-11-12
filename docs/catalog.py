#!/usr/bin/env python3
r"""Checks a feature catalog and writes its index.

A catalog is a folder of Markdown files, one per area, each card headed `### \`area.action\` — Title`.
This script finds every card, checks that identifiers are unique, that every identifier written in backticks
anywhere in the documents names a card, that each card has the lines its kind requires, that no document uses a
word the glossary says to avoid, and writes the index `README.md` of the catalog, keeping the status each card already
had there.

Usage:
    python catalog.py <docs folder> [--features features] [--index] [--fix-eol] [--ignore a.b,c.d]
                      [--glossary path]

The glossary is the first `*glossary*.md` of the docs folder, unless `--glossary` names another. Its table needs a
column headed `Avoid`, with the words to avoid comma separated; the first column is the term to use instead.

Exit code 0 when nothing is wrong, 1 when something is, 2 when the folder is not there.
Only the standard library is used.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

CARD = re.compile(r"^### `([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)` — (.+?)\s*$")
KIND = re.compile(r"^- \*\*Kind\*\*:\s*([A-Za-z]+)")
TABLE_NAME = re.compile(r"^\| `([^`]+)`")
FILE_SUFFIXES = {"rs", "ts", "js", "json", "jsonc", "md", "toml", "yaml", "yml", "txt", "lock", "com", "org", "io",
                 "net", "py", "sh", "ps1", "cfg", "ini", "xml", "html", "css"}
FIELD = re.compile(r"^- \*\*([A-Za-z ]+)\*\*:")
INDEX_ROW = re.compile(r"^\| \[`([^`]+)`\]\([^)]*\) \| .* \| ([^|]+) \|\s*$")
STATUSES = ("Specified", "Reviewed", "Built", "Seen", "Documented", "Differs")
REQUIRED = {
    "Operation": ("Function", "Danger", "Undo"),
    "Read": ("Function",),
    "View": ("Function",),
    "Derivation": ("Function",),
}


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def find_cards(features: Path) -> list[dict]:
    """Every card of the catalog, in file order, with the fields it has."""
    cards: list[dict] = []
    for file in sorted(features.glob("[0-9]*.md")):
        current = None
        for number, line in enumerate(read_text(file).splitlines(), start=1):
            match = CARD.match(line)
            if match:
                current = {"id": match.group(1), "title": match.group(2), "file": file.name, "line": number,
                           "kind": "", "fields": set(), "heading": line, "marked": False}
                cards.append(current)
                continue
            if line.startswith("## ") or line.startswith("# "):
                current = None
            if current is None:
                continue
            kind = KIND.match(line)
            if kind and not current["kind"]:
                current["kind"] = kind.group(1)
            field = FIELD.match(line)
            if field:
                current["fields"].add(field.group(1).strip())
            if "(differs)" in line:
                current["marked"] = True
    return cards


def find_references(documents: list[Path], prefixes: set[str]) -> dict[str, list[str]]:
    """Every identifier written in backticks whose area is an area of the catalog, with where it is."""
    if not prefixes:
        return {}
    pattern = re.compile(r"`((?:" + "|".join(re.escape(p) for p in sorted(prefixes, key=len, reverse=True))
                         + r")\.[a-z][a-z0-9-]*)`")
    found: dict[str, list[str]] = {}
    for file in documents:
        for number, line in enumerate(read_text(file).splitlines(), start=1):
            if CARD.match(line):
                continue
            for match in pattern.finditer(line):
                if match.group(1).rsplit(".", 1)[1] in FILE_SUFFIXES:
                    continue
                found.setdefault(match.group(1), []).append(f"{file.name}:{number}")
    return found


def declared_names(documents: list[Path]) -> set[str]:
    """Names that the first column of a table declares, such as settings: they are not references to cards."""
    names = set()
    for file in documents:
        for line in read_text(file).splitlines():
            match = TABLE_NAME.match(line)
            if match:
                names.add(match.group(1))
    return names


def words_to_avoid(glossary: Path) -> dict[str, str]:
    """The words the glossary says to avoid, each with the term to use instead."""
    avoid: dict[str, str] = {}
    column = -1
    for line in read_text(glossary).splitlines():
        if not line.startswith("|"):
            column = -1
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if column < 0:
            names = [cell.lower() for cell in cells]
            column = names.index("avoid") if "avoid" in names else -1
            continue
        if column >= len(cells) or set(cells[0]) <= set("-: "):
            continue
        term = cells[0].strip("`*_ ")
        for word in cells[column].split(","):
            word = word.strip("`*_ .")
            if word and word not in ("-", "—", "none"):
                avoid[word] = term
    return avoid


def plural(word: str) -> str:
    """A pattern for the word and its plural: copy and copies, branch and branches."""
    if len(word) > 2 and word.endswith("y") and word[-2] not in "aeiou":
        return re.escape(word[:-1]) + "(?:y|ies)"
    return re.escape(word) + "(?:s|es)?"


def find_avoided(documents: list[Path], avoid: dict[str, str]) -> dict[str, list[str]]:
    """Where each avoided word is used, outside code blocks, code spans and link targets."""
    patterns = {word: re.compile(r"(?<![\w-])" + plural(word) + r"(?![\w-])", re.IGNORECASE) for word in avoid}
    found: dict[str, list[str]] = {}
    for file in documents:
        fenced = False
        for number, line in enumerate(read_text(file).splitlines(), start=1):
            if line.lstrip().startswith(("```", "~~~")):
                fenced = not fenced
                continue
            if fenced:
                continue
            text = re.sub(r"`[^`]*`", "", line)
            text = re.sub(r"\]\([^)]*\)", "]", text)
            for word, pattern in patterns.items():
                if pattern.search(text):
                    found.setdefault(word, []).append(f"{file.name}:{number}")
    return found


def anchor(heading: str) -> str:
    """The anchor GitHub gives a heading."""
    text = heading.lstrip("#").strip().lower()
    text = re.sub(r"[^a-z0-9 _-]", "", text)
    return text.replace(" ", "-")


def existing_statuses(index: Path) -> dict[str, str]:
    if not index.exists():
        return {}
    statuses = {}
    for line in read_text(index).splitlines():
        match = INDEX_ROW.match(line)
        if match and match.group(2).strip() in STATUSES:
            statuses[match.group(1)] = match.group(2).strip()
    return statuses


def write_index(features: Path, cards: list[dict], default_status: str) -> None:
    index = features / "README.md"
    statuses = existing_statuses(index)
    files = sorted({card["file"] for card in cards})
    titles = {name: read_text(features / name).splitlines()[0].lstrip("# ").strip() for name in files}
    lines = [
        "# The catalog of features",
        "",
        f"Every feature, one card each, {len(cards)} in all. The template and the rules of the cards are in the",
        "feature contract. This index is written by `catalog.py --index`: change a status here in the commit that",
        "earns it, and run the script again after adding or renaming a card; the statuses are kept. A card with a",
        "**Differs** line is *Differs*; when the line goes, it becomes *Documented*.",
        "",
        "| File | Area | Cards |",
        "| --- | --- | --- |",
    ]
    for name in files:
        count = sum(1 for card in cards if card["file"] == name)
        lines.append(f"| [{name}]({name}) | {titles[name]} | {count} |")
    for name in files:
        lines += ["", f"## {titles[name]}", "", "| Feature | Title | Kind | Status |", "| --- | --- | --- | --- |"]
        for card in (card for card in cards if card["file"] == name):
            status = statuses.get(card["id"], default_status)
            if "Differs" in card["fields"]:
                status = "Differs"
            elif status == "Differs":
                status = "Documented"
            link = f"[`{card['id']}`]({name}#{anchor(card['heading'])})"
            lines.append(f"| {link} | {card['title']} | {card['kind'] or '?'} | {status} |")
    index.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {index} ({len(cards)} cards)")


def fix_line_endings(folder: Path) -> None:
    for file in folder.rglob("*.md"):
        data = file.read_bytes()
        if b"\r\n" in data:
            file.write_bytes(data.replace(b"\r\n", b"\n"))
            print(f"LF: {file}")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("docs", type=Path, help="the folder of the documents")
    parser.add_argument("--features", default="features", help="the catalog's folder inside it")
    parser.add_argument("--index", action="store_true", help="write the index of the catalog")
    parser.add_argument("--status", default="Specified", help="the status of a card new to the index")
    parser.add_argument("--fix-eol", action="store_true", help="turn CRLF into LF in every Markdown file")
    parser.add_argument("--ignore", default="", help="identifiers that look like cards but are not, comma separated")
    parser.add_argument("--glossary", type=Path, help="the glossary, when it is not the docs folder's *glossary*.md")
    arguments = parser.parse_args()

    docs: Path = arguments.docs.resolve()
    features = docs / arguments.features
    if not features.is_dir():
        print(f"no catalog at {features}", file=sys.stderr)
        return 2
    if arguments.fix_eol:
        fix_line_endings(docs)

    cards = find_cards(features)
    problems = 0
    seen: dict[str, dict] = {}
    for card in cards:
        if card["id"] in seen:
            first = seen[card["id"]]
            print(f"DUPLICATE {card['id']}: {first['file']}:{first['line']} and {card['file']}:{card['line']}")
            problems += 1
        seen[card["id"]] = card
        if card["kind"] not in REQUIRED:
            print(f"NO KIND {card['id']} ({card['file']}:{card['line']})")
            problems += 1
            continue
        if card["marked"] and "Differs" not in card["fields"]:
            print(f"NO DIFFERS LINE in {card['id']}, which marks a line (differs) ({card['file']}:{card['line']})")
            problems += 1
        missing = [field for field in REQUIRED[card["kind"]] if field not in card["fields"]]
        if missing:
            print(f"MISSING {', '.join(missing)} in {card['id']} ({card['file']}:{card['line']})")
            problems += 1

    prefixes = {card["id"].split(".")[0] for card in cards}
    ignored = {item.strip() for item in arguments.ignore.split(",") if item.strip()}
    documents = [path for path in docs.rglob("*.md") if path.name != "README.md" or path.parent != features]
    root = docs.parent
    documents += [path for path in root.glob("*.md") if path not in documents]
    ignored |= declared_names(documents)
    for identifier, places in sorted(find_references(documents, prefixes).items()):
        if identifier not in seen and identifier not in ignored:
            print(f"DANGLING {identifier}: {', '.join(places[:5])}{' ...' if len(places) > 5 else ''}")
            problems += 1

    glossary = arguments.glossary or next(iter(sorted(docs.glob("*glossary*.md"))), None)
    if glossary is not None and glossary.exists():
        avoid = words_to_avoid(glossary)
        checked = [path for path in documents if path.resolve() != glossary.resolve()]
        for word, places in sorted(find_avoided(checked, avoid).items()):
            print(f"AVOID \"{word}\" (the glossary says {avoid[word]}): "
                  f"{', '.join(places[:5])}{' ...' if len(places) > 5 else ''}")
            problems += 1
    elif arguments.glossary is not None:
        print(f"no glossary at {arguments.glossary}", file=sys.stderr)
        return 2

    by_kind: dict[str, int] = {}
    for card in cards:
        by_kind[card["kind"] or "?"] = by_kind.get(card["kind"] or "?", 0) + 1
    print(f"{len(cards)} cards in {len({card['file'] for card in cards})} files: "
          + ", ".join(f"{count} {kind}" for kind, count in sorted(by_kind.items())))

    if arguments.index:
        write_index(features, cards, arguments.status)
    print("no problems" if problems == 0 else f"{problems} problems")
    return 0 if problems == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
