using System.Text.RegularExpressions;

namespace SmAsia.Web.Services.Parsing;

/// <summary>
/// UNO Foods Inc. invoices. Item rows look like:
/// <c>2 *Case  DREN-002  Reno Liver Spread 24x78g UPC: 774310300203 NP   68.64   137.28</c>
/// where "*" marks a taxable line and the two numbers are case cost and extended cost.
/// </summary>
public partial class UnoFoodsInvoiceParser : IInvoiceParser
{
    public string Key => "unofoods";
    public string SupplierName => "UNO Foods Inc.";

    public bool CanParse(PdfLayout layout) =>
        layout.FullText.Contains("UNO FOODS", StringComparison.OrdinalIgnoreCase) ||
        layout.FullText.Contains("unofoodsinc.com", StringComparison.OrdinalIgnoreCase);

    public ParsedInvoice Parse(PdfLayout layout)
    {
        var inv = new ParsedInvoice { ParserKey = Key, SupplierName = SupplierName };
        inv.InvoiceNumber = layout.FirstMatch(InvoiceNoRegex());
        inv.OrderNumber = layout.FirstMatch(OrderNoRegex());
        var dateText = layout.FirstMatch(DateRegex());
        inv.InvoiceDate = ProductText.ParseLooseDate(dateText);
        inv.Terms = layout.Lines.Select(l => l.Text).FirstOrDefault(t => t.StartsWith("TERMS", StringComparison.OrdinalIgnoreCase))
            ?.Split(':', 2).ElementAtOrDefault(1)?.Trim();
        inv.CustomerPo = FindPurchaseOrder(layout);

        // Column positions come from each page's header row; fall back to the positions seen on known invoices.
        var columns = new Dictionary<int, (double unitLeft, double split)>();
        foreach (var header in layout.Lines.Where(l => l.Words.Any(w => w.Text == "UNIT") && l.Words.Any(w => w.Text == "EXTENDED")))
        {
            var unit = header.Words.First(w => w.Text == "UNIT");
            var ext = header.Words.First(w => w.Text == "EXTENDED");
            columns[header.Page] = (unit.Left - 40, (unit.Right + ext.Left) / 2);
        }

        foreach (var line in layout.Lines)
        {
            var w = line.Words;
            if (w.Count < 4) continue;
            if (!QtyRegex().IsMatch(w[0].Text) || w[0].Left > 60) continue;
            var uomWord = w[1];
            var codeWord = w.Skip(1).Take(2).FirstOrDefault(x => ItemCodeRegex().IsMatch(x.Text));
            if (codeWord == null) continue;

            var (costLeft, split) = columns.TryGetValue(line.Page, out var c) ? c : (420, 505);
            var descText = string.Join(' ', w.Where(x => x.Left > codeWord.Right + 2 && x.Center < costLeft).Select(x => x.Text));
            var numbers = w.Where(x => x.Center >= costLeft).Select(x => (x, v: PdfLayout.ParseDecimal(x.Text))).Where(t => t.v != null).ToList();
            var unitCost = numbers.FirstOrDefault(t => t.x.Center < split).v;
            var extended = numbers.LastOrDefault(t => t.x.Center >= split).v;

            var qty = decimal.Parse(w[0].Text);
            var item = new ParsedInvoiceLine
            {
                ItemCode = codeWord.Text,
                Uom = uomWord == codeWord ? null : uomWord.Text.TrimStart('*'),
                Taxable = uomWord.Text.StartsWith('*'),
                QtyOrdered = qty,
                QtyShipped = qty,
                Upc = ProductText.ExtractUpc(descText),
                Description = ProductText.CleanDescription(descText),
                UnitCost = unitCost ?? (extended.HasValue && qty != 0 ? Math.Round(extended.Value / qty, 2) : 0),
                Extended = extended ?? (unitCost ?? 0) * qty,
            };
            item.PackUnits = ProductText.PackUnits(item.Description);
            if (unitCost == null || extended == null)
                inv.Warnings.Add($"{item.ItemCode}: could not read both case cost and extended cost — please check.");
            inv.Lines.Add(item);
        }

        inv.Subtotal = layout.NumberRightOf("Sub Total:");
        inv.Tax = layout.NumberRightOf("*Tax (GST/HST):") ?? layout.NumberRightOf("Tax (GST/HST):");
        inv.Total = layout.NumberRightOf("Total Amount:");

        if (inv.Subtotal is { } sub && Math.Abs(sub - inv.LinesTotal) > 0.05m)
            inv.Warnings.Add($"Line total {inv.LinesTotal:N2} does not match invoice subtotal {sub:N2}.");
        if (inv.Lines.Count == 0)
            inv.Warnings.Add("No item lines were found on this invoice.");
        return inv;
    }

    private static string? FindPurchaseOrder(PdfLayout layout)
    {
        // "PURCHASE ORDER" header sits above a row: OR00086374  DRY  Aug 04, 2026 ...
        foreach (var line in layout.Lines)
        {
            var order = line.Words.FirstOrDefault(w => OrderNoRegex().IsMatch(w.Text));
            if (order == null) continue;
            var next = line.Words.SkipWhile(w => w != order).Skip(1).FirstOrDefault();
            if (next != null && !InvoiceNoRegex().IsMatch(next.Text) && !MonthRegex().IsMatch(next.Text)) return next.Text;
            return null;
        }
        return null;
    }

    [GeneratedRegex(@"^\d{1,4}$")] private static partial Regex QtyRegex();
    [GeneratedRegex(@"^[A-Z0-9]{2,6}-[A-Z0-9]{2,6}$")] private static partial Regex ItemCodeRegex();
    [GeneratedRegex(@"\b(IN\d{6,})\b")] private static partial Regex InvoiceNoRegex();
    [GeneratedRegex(@"\b(OR\d{6,})\b")] private static partial Regex OrderNoRegex();
    [GeneratedRegex(@"\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4})\b")] private static partial Regex DateRegex();
    [GeneratedRegex(@"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)")] private static partial Regex MonthRegex();
}
