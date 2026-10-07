# Python support dependencies

This optional environment provides PyMuPDF and PyYAML. It does not include Python or a copied virtual environment. Create it on your data drive with your own Python:

```powershell
python -m venv D:/ai-work-runtime/python-support
& D:/ai-work-runtime/python-support/Scripts/python.exe -m pip install --only-binary=:all: -r tools/python-support/requirements.txt
```

Use `-X utf8` when running scripts on Windows. Import PyMuPDF with `import pymupdf`. The package licences apply independently of this repository's MIT licence.
