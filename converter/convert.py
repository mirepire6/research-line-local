"""Convert one local document with Microsoft MarkItDown."""

import contextlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from zipfile import BadZipFile, ZipFile


MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_OFFICE_BYTES = 256 * 1024 * 1024
MAX_OFFICE_ENTRIES = 4096
MAX_MARKDOWN_CHARS = 100_000

FORMATS = {
    ".pdf": ("application/pdf", "PdfConverter"),
    ".docx": (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "DocxConverter",
    ),
    ".xlsx": (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "XlsxConverter",
    ),
    ".xls": ("application/vnd.ms-excel", "XlsConverter"),
    ".pptx": (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "PptxConverter",
    ),
    ".html": ("text/html", "HtmlConverter"),
    ".htm": ("text/html", "HtmlConverter"),
    ".csv": ("text/csv", "CsvConverter"),
    ".tsv": ("text/tab-separated-values", "PlainTextConverter"),
    ".txt": ("text/plain", "PlainTextConverter"),
    ".md": ("text/markdown", "PlainTextConverter"),
    ".json": ("application/json", "PlainTextConverter"),
    ".xml": ("text/xml", "PlainTextConverter"),
}

OFFICE_PARTS = {
    ".docx": "word/document.xml",
    ".xlsx": "xl/workbook.xml",
    ".pptx": "ppt/presentation.xml",
}


def validate_office_archive(source, required_part):
    with ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_OFFICE_ENTRIES or sum(item.file_size for item in entries) > MAX_OFFICE_BYTES:
            raise ValueError("The Office document expands beyond the conversion limit.")
        if not {"[Content_Types].xml", required_part}.issubset(archive.namelist()):
            raise ValueError("The file contents do not match its Office extension.")
    source.seek(0)


def convert(path):
    drive = path.drive.removeprefix("\\\\?\\")
    if drive and not re.fullmatch(r"[A-Za-z]:", drive):
        raise ValueError("Choose a document on a local drive.")
    if ":" in path.name or not path.is_file():
        raise ValueError("Choose an existing local file.")

    extension = path.suffix.casefold()
    if extension not in FORMATS:
        raise ValueError("Unsupported document format. Try PDF, Office, HTML, or text.")
    mimetype, converter_name = FORMATS[extension]

    # Register only the converter for the selected format. In particular, the
    # generic archive and network-aware converters never see uploaded content.
    from markitdown import MarkItDown, StreamInfo, converters

    reader = MarkItDown(enable_builtins=False, enable_plugins=False)
    reader.register_converter(getattr(converters, converter_name)())
    with path.open("rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
            raise ValueError("Choose a regular file up to 25 MiB.")
        if extension in OFFICE_PARTS:
            validate_office_archive(source, OFFICE_PARTS[extension])
        result = reader.convert_stream(
            source, stream_info=StreamInfo(extension=extension, mimetype=mimetype)
        )

    markdown = result.markdown
    if not markdown.strip():
        raise ValueError("No extractable text was found. A scanned PDF may need OCR first.")
    return {"markdown": markdown[:MAX_MARKDOWN_CHARS], "truncated": len(markdown) > MAX_MARKDOWN_CHARS}


def main():
    if len(sys.argv) != 2:
        print("Usage: convert.py <local document>", file=sys.stderr)
        return 2
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = convert(Path(sys.argv[1]))
    except ModuleNotFoundError:
        print("MarkItDown is missing. Run scripts/setup-markitdown.ps1.", file=sys.stderr)
        return 1
    except BadZipFile:
        print("The Office document is damaged or in a different format.", file=sys.stderr)
        return 1
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print("MarkItDown could not read this document. Check the file and try again.", file=sys.stderr)
        return 1
    output = json.dumps(result, ensure_ascii=False)
    sys.stdout.buffer.write(output.encode("utf-8") + b"\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
