namespace SmAsia.Web.Services.Parsing;

public class ParsedInvoice
{
    public string ParserKey { get; set; } = "";
    public string SupplierName { get; set; } = "";
    public string? InvoiceNumber { get; set; }
    public DateOnly? InvoiceDate { get; set; }
    public string? OrderNumber { get; set; }
    public string? CustomerPo { get; set; }
    public string? Terms { get; set; }
    public decimal? Subtotal { get; set; }
    public decimal? Tax { get; set; }
    public decimal? Total { get; set; }
    public List<ParsedInvoiceLine> Lines { get; } = [];
    public List<string> Warnings { get; } = [];

    public decimal LinesTotal => Lines.Sum(l => l.Extended);
}

public class ParsedInvoiceLine
{
    public string ItemCode { get; set; } = "";
    public string Description { get; set; } = "";
    public string? Upc { get; set; }
    public string? Uom { get; set; }
    public decimal QtyOrdered { get; set; }
    public decimal QtyShipped { get; set; }
    /// <summary>Price per UOM (normally per case).</summary>
    public decimal UnitCost { get; set; }
    public decimal Extended { get; set; }
    public decimal Tax { get; set; }
    public bool Taxable { get; set; }
    /// <summary>Sellable units per case, read from the pack size in the description (e.g. 24/425g → 24).</summary>
    public int? PackUnits { get; set; }
}

public interface IInvoiceParser
{
    string Key { get; }
    string SupplierName { get; }
    bool CanParse(PdfLayout layout);
    ParsedInvoice Parse(PdfLayout layout);
}
