using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Services.Parsing;

namespace SmAsia.Web.Services;

public record ProductMatch(int ProductId, string Method);

/// <summary>
/// In-memory index for matching invoice lines and report rows to products.
/// Order of preference: supplier item code → barcode → alias → exact name → close name.
/// </summary>
public class ProductMatcher
{
    private readonly Dictionary<(int, string), int> _supplierCodes = new();
    private readonly Dictionary<string, int> _barcodes = new();
    private readonly Dictionary<string, int> _barcodesNoCheck = new();
    private readonly Dictionary<string, int> _aliasCodes = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, int> _names = new();
    private readonly List<(int Id, HashSet<string> Tokens)> _tokens = [];

    public static async Task<ProductMatcher> LoadAsync(AppDbContext db)
    {
        var m = new ProductMatcher();
        var products = await db.Products.Where(p => p.IsActive).Select(p => new { p.Id, p.Barcode, p.Name }).ToListAsync();
        foreach (var p in products) m.AddProduct(p.Id, p.Barcode, p.Name);

        foreach (var sp in await db.SupplierProducts.Select(s => new { s.SupplierId, s.SupplierItemCode, s.ProductId }).ToListAsync())
            m._supplierCodes[(sp.SupplierId, sp.SupplierItemCode.ToUpperInvariant())] = sp.ProductId;

        foreach (var a in await db.ProductAliases.Select(a => new { a.ProductId, a.Code, a.Name }).ToListAsync())
        {
            if (!string.IsNullOrWhiteSpace(a.Code)) m._aliasCodes[a.Code.Trim()] = a.ProductId;
            var key = ProductText.NameKey(a.Name);
            if (key.Length > 0) m._names.TryAdd(key, a.ProductId);
        }
        return m;
    }

    public void AddProduct(int id, string? barcode, string name)
    {
        var bc = ProductText.NormalizeBarcode(barcode);
        if (bc != null)
        {
            _barcodes.TryAdd(bc, id);
            if (bc.Length >= 7) _barcodesNoCheck.TryAdd(bc[..^1], id);
        }
        var key = ProductText.NameKey(name);
        if (key.Length > 0) _names.TryAdd(key, id);
        _tokens.Add((id, Tokens(name)));
    }

    public void AddSupplierCode(int supplierId, string code, int productId) =>
        _supplierCodes[(supplierId, code.ToUpperInvariant())] = productId;

    public int? ByBarcode(string? code)
    {
        var bc = ProductText.NormalizeBarcode(code);
        if (bc == null) return null;
        if (_barcodes.TryGetValue(bc, out var id)) return id;
        if (bc.Length >= 6 && _barcodesNoCheck.TryGetValue(bc, out id)) return id;       // code printed without check digit
        if (bc.Length >= 7 && _barcodes.TryGetValue(bc[..^1], out id)) return id;          // product stored without check digit
        return null;
    }

    public ProductMatch? MatchInvoiceLine(int supplierId, string? itemCode, string? upc, string? description)
    {
        if (!string.IsNullOrWhiteSpace(itemCode) && _supplierCodes.TryGetValue((supplierId, itemCode.ToUpperInvariant()), out var id))
            return new(id, "Supplier code");
        if (ByBarcode(upc) is { } b) return new(b, "Barcode");
        return MatchName(description);
    }

    public ProductMatch? MatchReportRow(string? code, string? name)
    {
        if (!string.IsNullOrWhiteSpace(code))
        {
            if (_aliasCodes.TryGetValue(code.Trim(), out var a)) return new(a, "Alias");
            if (ByBarcode(code) is { } b) return new(b, "Barcode");
        }
        var key = ProductText.NameKey(name);
        if (key.Length > 0 && _names.TryGetValue(key, out var n)) return new(n, "Name");
        return null;
    }

    private ProductMatch? MatchName(string? name)
    {
        var key = ProductText.NameKey(name);
        if (key.Length == 0) return null;
        if (_names.TryGetValue(key, out var id)) return new(id, "Name");

        // Close match on words, e.g. "Palm Liver Spread 24/227g" ~ "PALM LIVER SPREAD 227G". Flagged for review.
        var tokens = Tokens(name!);
        if (tokens.Count < 2) return null;
        (int Id, double Score) best = (0, 0);
        foreach (var (pid, pt) in _tokens)
        {
            if (pt.Count == 0) continue;
            var common = tokens.Count(pt.Contains);
            var score = (double)common / Math.Max(tokens.Count, pt.Count);
            if (score > best.Score) best = (pid, score);
        }
        return best.Score >= 0.6 ? new(best.Id, "Similar name") : null;
    }

    private static HashSet<string> Tokens(string name)
    {
        var cleaned = System.Text.RegularExpressions.Regex.Replace(name.ToLowerInvariant(), @"\d+\s*[/x]\s*\(?", " ");
        return cleaned.Split([' ', '-', '(', ')', ',', '.', '/', '&', '*'], StringSplitOptions.RemoveEmptyEntries)
            .Where(t => t.Length > 1 && t is not ("the" or "and" or "with" or "in" or "of"))
            .ToHashSet();
    }
}
