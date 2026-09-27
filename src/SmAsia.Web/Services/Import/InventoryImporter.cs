using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services.Parsing;

namespace SmAsia.Web.Services.Import;

public enum CountMode { FirstOnly, SecondIfPresent, Sum }

public class InventoryImportOptions
{
    public int HeaderRow { get; set; }
    public Dictionary<string, int> Mapping { get; set; } = new();
    public bool CreateNew { get; set; } = true;
    public bool UpdateExisting { get; set; } = true;
    public bool SetStock { get; set; } = true;
    public CountMode CountMode { get; set; } = CountMode.SecondIfPresent;
    public int? SupplierId { get; set; }
}

/// <summary>Imports a product list / stock count sheet such as the SM ASIA inventory workbook.</summary>
public class InventoryImporter(AppDbContext db, InventoryService inventory)
{
    public async Task<ImportResult> ImportAsync(TabularFile file, string fileName, InventoryImportOptions o)
    {
        var result = new ImportResult();
        var map = o.Mapping;
        if (!map.ContainsKey("Name")) { result.Errors.Add("Map the Item name column."); return result; }
        string? Cell(string?[] row, string key) => map.TryGetValue(key, out var i) && i >= 0 && i < row.Length ? row[i] : null;

        var products = await db.Products.ToListAsync();
        var byBarcode = new Dictionary<string, Product>();
        var byName = new Dictionary<string, Product>();
        foreach (var p in products)
        {
            if (ProductText.NormalizeBarcode(p.Barcode) is { } bc) byBarcode.TryAdd(bc, p);
            byName.TryAdd(ProductText.NameKey(p.Name), p);
        }
        var categories = await db.Categories.ToDictionaryAsync(c => c.Name.Trim().ToLowerInvariant());

        var batch = new ImportBatch { Type = ImportType.Inventory, FileName = fileName, FileHash = file.Hash, AffectedStock = o.SetStock };
        await using var tx = await db.Database.BeginTransactionAsync();
        db.ImportBatches.Add(batch);
        await db.SaveChangesAsync();

        int created = 0, updated = 0, counted = 0;
        var log = new List<string>();
        var seenInFile = new HashSet<Product>();
        foreach (var row in file.Rows.Skip(o.HeaderRow + 1))
        {
            batch.RowsRead++;
            var name = Cell(row, "Name")?.Trim();
            if (string.IsNullOrWhiteSpace(name) || name == "-") { batch.RowsSkipped++; continue; }

            var barcode = CleanBarcode(Cell(row, "Barcode"));
            Product? product = null;
            if (barcode != null) byBarcode.TryGetValue(ProductText.NormalizeBarcode(barcode)!, out product);
            product ??= byName.GetValueOrDefault(ProductText.NameKey(name));

            bool isNew = product == null;
            if (isNew)
            {
                if (!o.CreateNew) { batch.RowsSkipped++; continue; }
                product = new Product { Name = name, Barcode = barcode, PreferredSupplierId = o.SupplierId };
                db.Products.Add(product);
                if (barcode != null) byBarcode.TryAdd(ProductText.NormalizeBarcode(barcode)!, product);
                byName.TryAdd(ProductText.NameKey(name), product);
                created++;
            }
            else if (!o.UpdateExisting && !o.SetStock) { batch.RowsSkipped++; continue; }

            if (isNew || o.UpdateExisting)
            {
                if (!isNew) updated++;
                if (barcode != null && string.IsNullOrWhiteSpace(product!.Barcode)) product.Barcode = barcode;
                var cat = Cell(row, "Category")?.Trim();
                if (!string.IsNullOrEmpty(cat) && cat != "-")
                {
                    if (!categories.TryGetValue(cat.ToLowerInvariant(), out var category))
                    {
                        category = new Category { Name = cat };
                        db.Categories.Add(category);
                        categories[cat.ToLowerInvariant()] = category;
                    }
                    product!.Category = category;
                }
                var loc = Cell(row, "Location")?.Trim();
                if (!string.IsNullOrEmpty(loc) && loc != "-") product!.Location = loc;
                if (ProductText.ParseLooseDate(Cell(row, "Expiry")) is { } exp && exp.Year > 2000) product!.NearestExpiry = exp;
                if (TabularFile.ParseNumber(Cell(row, "SellPrice")) is { } price and > 0) product!.SellPrice = price;
                if (TabularFile.ParseNumber(Cell(row, "UnitCost")) is { } cost and > 0) product!.UnitCost = cost;
                if (TabularFile.ParseNumber(Cell(row, "UnitsPerCase")) is { } upc and >= 1) product!.UnitsPerCase = (int)upc;
                if (TabularFile.ParseNumber(Cell(row, "MinStock")) is { } min and >= 0) product!.MinStock = min;
                if (o.SupplierId != null) product!.PreferredSupplierId ??= o.SupplierId;
                product!.UpdatedAt = DateTime.UtcNow;
            }

            if (o.SetStock)
            {
                var q1 = TabularFile.ParseNumber(Cell(row, "Quantity"));
                var q2 = TabularFile.ParseNumber(Cell(row, "Quantity2"));
                decimal? qty = o.CountMode switch
                {
                    CountMode.FirstOnly => q1,
                    CountMode.SecondIfPresent => q2 ?? q1,
                    _ => q1 == null && q2 == null ? null : (q1 ?? 0) + (q2 ?? 0),
                };
                if (qty != null)
                {
                    // The same item listed twice on a count sheet (e.g. two shelves) adds up.
                    if (!seenInFile.Add(product!)) qty += product!.QtyOnHand;
                    if (isNew && product!.Id == 0)
                    {
                        if (qty != 0) inventory.Move(product, MovementType.Opening, qty.Value, $"Inventory import #{batch.Id}", fileName, importBatchId: batch.Id);
                    }
                    else if (inventory.SetCount(product!, qty.Value, $"Inventory import #{batch.Id}", fileName, batch.Id) != null) counted++;
                }
            }
            batch.RowsImported++;
        }

        log.Add($"{created} new products, {updated} updated, {counted} stock levels changed.");
        batch.Log = string.Join(" ", log);
        await db.SaveChangesAsync();
        await tx.CommitAsync();
        result.Batch = batch;
        return result;
    }

    /// <summary>Keeps real barcodes (6+ digits); drops placeholder text like "-" or a category name typed in the barcode column.</summary>
    private static string? CleanBarcode(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var digits = new string(raw.Where(char.IsDigit).ToArray());
        return digits.Length >= 6 && digits.Length >= raw.Trim().Length - 2 ? digits : null;
    }
}
