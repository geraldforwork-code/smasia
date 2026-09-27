namespace SmAsia.Web.Services.Parsing;

/// <summary>
/// Picks the parser for a supplier invoice PDF. To support a new supplier, implement
/// <see cref="IInvoiceParser"/> and register it in Program.cs.
/// </summary>
public class InvoiceParserRegistry(IEnumerable<IInvoiceParser> parsers)
{
    public IReadOnlyList<IInvoiceParser> Parsers { get; } = parsers.ToList();

    public (ParsedInvoice? Invoice, string? Error) Parse(Stream pdf, string? parserKey = null)
    {
        PdfLayout layout;
        try { layout = PdfLayout.Load(pdf); }
        catch (Exception ex) { return (null, $"Could not read the PDF: {ex.Message}"); }

        if (layout.Lines.Count == 0)
            return (null, "The PDF has no text layer (it may be a scanned image). Enter this receipt manually.");

        var parser = parserKey != null
            ? Parsers.FirstOrDefault(p => p.Key == parserKey)
            : Parsers.FirstOrDefault(p => p.CanParse(layout));
        if (parser == null)
            return (null, "This invoice layout is not recognised. Supported suppliers: " + string.Join(", ", Parsers.Select(p => p.SupplierName)) + ".");

        return (parser.Parse(layout), null);
    }
}
