using System.Text.RegularExpressions;

namespace SmAsia.Web.Services.Parsing;

/// <summary>
/// Dong Phuong Distributor invoices. Columns: Item No | Description/Packing | UOM | EAN/UPC |
/// Order | Ship | Price | Env | Dep | GST | Amount | KG | Shipment No.
/// Numbers are right-aligned under their headers, so each is assigned to the nearest header.
/// </summary>
public partial class DongPhuongInvoiceParser : IInvoiceParser
{
    public string Key => "dongphuong";
    public string SupplierName => "Dong Phuong Distributor";

    private static readonly string[] NumericColumns = ["Order", "Ship", "Price", "Env", "Dep", "GST", "Amount"];

    public bool CanParse(PdfLayout layout) =>
        layout.FullText.Contains("Dong Phuong", StringComparison.OrdinalIgnoreCase) ||
        layout.FullText.Contains("DPDISTRIBUTOR", StringComparison.OrdinalIgnoreCase);

    public ParsedInvoice Parse(PdfLayout layout)
    {
        var inv = new ParsedInvoice { ParserKey = Key, SupplierName = SupplierName };
        inv.InvoiceNumber = layout.WordRightOf("Invoice No:");
        inv.InvoiceDate = ProductText.ParseLooseDate(layout.WordRightOf("Invoice Date:"));
        inv.OrderNumber = layout.FirstMatch(OrderRegex());
        var terms = layout.WordRightOf("Terms:");
        inv.Terms = terms == null ? null : $"{terms} Days";

        var headers = new Dictionary<int, Dictionary<string, PdfWord>>();
        foreach (var line in layout.Lines.Where(l => l.Words.Any(w => w.Text == "UOM") && l.Words.Any(w => w.Text == "EAN/UPC")))
            headers[line.Page] = line.Words.GroupBy(w => w.Text).ToDictionary(g => g.Key, g => g.First());

        if (headers.Count == 0 || !headers.Values.First().ContainsKey("Amount"))
        {
            inv.Warnings.Add("Could not find the item column headings on this invoice.");
            return inv;
        }

        foreach (var line in layout.Lines)
        {
            var h = headers.GetValueOrDefault(line.Page) ?? headers.Values.First();
            var w = line.Words;
            if (w.Count < 5 || w[0].Left > 45 || !ItemNoRegex().IsMatch(w[0].Text)) continue;

            var uomHeader = h["UOM"];
            var upcHeader = h["EAN/UPC"];
            var firstNumeric = h.TryGetValue("Order", out var ord) ? ord.Left - 8 : upcHeader.Right + 20;
            var amountRight = h["Amount"].Right + 15;

            var uom = w.FirstOrDefault(x => Math.Abs(x.Center - uomHeader.Center) < 18 && UomRegex().IsMatch(x.Text));
            var descEnd = uom?.Left ?? uomHeader.Left - 5;
            var desc = string.Join(' ', w.Skip(1).Where(x => x.Right <= descEnd + 1).Select(x => x.Text));
            var upc = w.FirstOrDefault(x => x.Left >= descEnd && x.Center < firstNumeric && DigitsRegex().IsMatch(x.Text))?.Text;

            var values = new Dictionary<string, decimal>();
            foreach (var word in w.Where(x => x.Left >= firstNumeric && x.Right <= amountRight))
            {
                var v = PdfLayout.ParseDecimal(word.Text);
                if (v == null) continue;
                var col = NumericColumns.Where(h.ContainsKey).OrderBy(c => Math.Abs(h[c].Center - word.Center)).FirstOrDefault();
                if (col != null && !values.ContainsKey(col)) values[col] = v.Value;
            }

            if (!values.TryGetValue("Ship", out var shipped) && !values.TryGetValue("Order", out shipped)) continue;
            values.TryGetValue("Price", out var price);
            var amount = values.TryGetValue("Amount", out var a) ? a : shipped * price;
            var gst = values.GetValueOrDefault("GST");

            var item = new ParsedInvoiceLine
            {
                ItemCode = w[0].Text,
                Description = ProductText.CleanDescription(desc),
                Uom = uom?.Text,
                Upc = upc,
                QtyOrdered = values.GetValueOrDefault("Order", shipped),
                QtyShipped = shipped,
                UnitCost = price,
                Extended = amount,
                Tax = gst,
                Taxable = gst != 0,
            };
            item.PackUnits = ProductText.PackUnits(item.Description);
            if (item.QtyOrdered != item.QtyShipped)
                inv.Warnings.Add($"{item.ItemCode}: ordered {item.QtyOrdered:0.##} but shipped {item.QtyShipped:0.##}.");
            inv.Lines.Add(item);
        }

        // "Total Amount" on this invoice is the pre-tax goods total; "Amount due" includes GST.
        inv.Subtotal = layout.NumberRightOf("Total Amount");
        inv.Tax = layout.NumberRightOf("G.S.T") ?? inv.Lines.Sum(l => l.Tax);
        inv.Total = layout.NumberRightOf("Amount due");

        if (inv.Subtotal is { } sub && Math.Abs(sub - inv.LinesTotal) > 0.05m)
            inv.Warnings.Add($"Line total {inv.LinesTotal:N2} does not match invoice total {sub:N2}.");
        if (inv.Lines.Count == 0)
            inv.Warnings.Add("No item lines were found on this invoice.");
        return inv;
    }

    [GeneratedRegex(@"^(?=.*\d)[0-9A-Z]{4,12}$")] private static partial Regex ItemNoRegex();
    [GeneratedRegex(@"^(CS|EA|BX|PK|KG|LB|BG|CT|DZ|PC|BAG|CASE|EACH)$", RegexOptions.IgnoreCase)] private static partial Regex UomRegex();
    [GeneratedRegex(@"^\d{6,14}$")] private static partial Regex DigitsRegex();
    [GeneratedRegex(@"\b(ORD\d{5,})\b")] private static partial Regex OrderRegex();
}
