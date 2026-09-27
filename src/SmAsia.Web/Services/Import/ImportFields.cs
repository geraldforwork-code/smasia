namespace SmAsia.Web.Services.Import;

public record ImportField(string Key, string Label, bool Required, string[] Keywords, string Help = "");

/// <summary>The target fields each import type can map spreadsheet columns onto, with header keywords for auto-mapping.</summary>
public static class ImportFields
{
    public static readonly ImportField[] Sales =
    [
        new("Date", "Sale date", false, ["date", "day", "trans date", "business date"], "Leave unmapped if the report covers a period — you can enter the period instead."),
        new("Code", "Barcode / PLU / SKU", false, ["barcode", "upc", "ean", "plu", "sku", "item code", "product code", "code", "item no", "item #"]),
        new("Name", "Item description", false, ["description", "item name", "product name", "product", "item", "name"]),
        new("Quantity", "Quantity sold", true, ["qty sold", "quantity", "qty", "units sold", "units", "sold", "count", "volume"]),
        new("Amount", "Net sales $", false, ["net sales", "net", "sales", "total", "amount", "value", "revenue", "gross"]),
    ];

    public static readonly ImportField[] Inventory =
    [
        new("Barcode", "Barcode", false, ["barcode", "upc", "ean", "sku", "plu"]),
        new("Name", "Item name", true, ["item name", "description", "product", "name", "item"]),
        new("Category", "Category", false, ["categor", "department", "dept", "group"]),
        new("Location", "Stock location", false, ["location", "aisle", "shelf", "bin"]),
        new("Quantity", "Quantity on hand", false, ["count 1", "count", "on hand", "qty in display", "stock", "qty"], "Creates a stock-count adjustment."),
        new("Quantity2", "Second count (optional)", false, ["count 2"], "Used together with the first count — see the option below."),
        new("Expiry", "Expiry date", false, ["expir", "expiry", "best before", "bb"]),
        new("SellPrice", "Selling price", false, ["price each (recent)", "price each", "retail", "sell", "price"]),
        new("UnitCost", "Unit cost", false, ["unit cost", "cost"]),
        new("UnitsPerCase", "Units per case", false, ["units per case", "pack", "case qty"]),
        new("MinStock", "Minimum stock", false, ["min", "reorder level", "par"]),
    ];

    /// <summary>Maps each field to the best-matching header column (each column used once, earlier keywords win).</summary>
    public static Dictionary<string, int> AutoMap(ImportField[] fields, string?[] header)
    {
        var map = new Dictionary<string, int>();
        var used = new HashSet<int>();
        var cells = header.Select(h => (h ?? "").Trim().ToLowerInvariant()).ToArray();
        foreach (var f in fields)
        {
            foreach (var kw in f.Keywords)
            {
                var idx = Array.FindIndex(cells, c => c == kw);
                if (idx < 0) idx = Enumerable.Range(0, cells.Length).FirstOrDefault(i => !used.Contains(i) && cells[i].Contains(kw), -1);
                if (idx >= 0 && !used.Contains(idx)) { map[f.Key] = idx; used.Add(idx); break; }
            }
        }
        return map;
    }
}
