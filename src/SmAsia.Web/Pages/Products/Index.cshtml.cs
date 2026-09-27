using ClosedXML.Excel;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;

namespace SmAsia.Web.Pages.Products;

public class IndexModel(AppDbContext db) : PageModel
{
    [BindProperty(SupportsGet = true)] public string? Q { get; set; }
    [BindProperty(SupportsGet = true)] public int? CategoryId { get; set; }
    [BindProperty(SupportsGet = true)] public int? SupplierId { get; set; }
    [BindProperty(SupportsGet = true)] public string? Location { get; set; }
    [BindProperty(SupportsGet = true)] public string? Filter { get; set; }
    [BindProperty(SupportsGet = true)] public string Sort { get; set; } = "name";
    [BindProperty(SupportsGet = true)] public int PageNo { get; set; } = 1;
    public const int PageSize = 50;

    public List<Product> Items { get; set; } = [];
    public int Total { get; set; }
    public List<Category> Categories { get; set; } = [];
    public List<Supplier> Suppliers { get; set; } = [];
    public List<string> Locations { get; set; } = [];

    private IQueryable<Product> Query()
    {
        var q = db.Products.Include(p => p.Category).Include(p => p.PreferredSupplier).AsQueryable();
        q = Filter == "inactive" ? q.Where(p => !p.IsActive) : q.Where(p => p.IsActive);
        if (!string.IsNullOrWhiteSpace(Q))
        {
            var t = Q.Trim();
            q = q.Where(p => p.Name.Contains(t) || (p.Barcode != null && p.Barcode.Contains(t)) || p.SupplierProducts.Any(s => s.SupplierItemCode == t));
        }
        if (CategoryId != null) q = q.Where(p => p.CategoryId == CategoryId);
        if (SupplierId != null) q = q.Where(p => p.PreferredSupplierId == SupplierId);
        if (!string.IsNullOrEmpty(Location)) q = q.Where(p => p.Location == Location);
        var soon = DateOnly.FromDateTime(DateTime.Today.AddDays(60));
        q = Filter switch
        {
            "out" => q.Where(p => p.QtyOnHand <= 0),
            "low" => q.Where(p => p.MinStock > 0 && p.QtyOnHand < p.MinStock),
            "expiring" => q.Where(p => p.NearestExpiry != null && p.NearestExpiry <= soon && p.QtyOnHand > 0),
            "nobarcode" => q.Where(p => p.Barcode == null || p.Barcode == ""),
            "nosupplier" => q.Where(p => p.PreferredSupplierId == null),
            _ => q,
        };
        return Sort switch
        {
            "qty" => q.OrderBy(p => p.QtyOnHand).ThenBy(p => p.Name),
            "location" => q.OrderBy(p => p.Location).ThenBy(p => p.Name),
            "expiry" => q.OrderBy(p => p.NearestExpiry == null).ThenBy(p => p.NearestExpiry),
            "category" => q.OrderBy(p => p.Category!.Name).ThenBy(p => p.Name),
            _ => q.OrderBy(p => p.Name),
        };
    }

    public async Task OnGetAsync()
    {
        var q = Query();
        Total = await q.CountAsync();
        PageNo = Math.Max(1, PageNo);
        Items = await q.Skip((PageNo - 1) * PageSize).Take(PageSize).AsNoTracking().ToListAsync();
        Categories = await db.Categories.OrderBy(c => c.Name).ToListAsync();
        Suppliers = await db.Suppliers.OrderBy(s => s.Name).ToListAsync();
        Locations = await db.Products.Where(p => p.Location != null).Select(p => p.Location!).Distinct().OrderBy(l => l).ToListAsync();
    }

    /// <summary>Downloads the filtered list as a count sheet in the same shape as the store's inventory workbook.</summary>
    public async Task<IActionResult> OnGetExportAsync()
    {
        var items = await Query().AsNoTracking().ToListAsync();
        using var wb = new XLWorkbook();
        var ws = wb.AddWorksheet("Inventory");
        string[] headers = ["BARCODE", "CATEGORIES", "ITEM NAME", "STOCK LOCATION", "EXPIRY DATE", "SYSTEM QTY", "COUNT 1", "COUNT 2", "UNITS PER CASE", "UNIT COST", "PRICE EACH"];
        for (int i = 0; i < headers.Length; i++) ws.Cell(1, i + 1).Value = headers[i];
        ws.Row(1).Style.Font.Bold = true;
        ws.Row(1).Style.Fill.BackgroundColor = XLColor.FromHtml("#E5F4F1");
        int r = 2;
        foreach (var p in items)
        {
            ws.Cell(r, 1).Value = p.Barcode;
            ws.Cell(r, 1).Style.NumberFormat.Format = "@";
            ws.Cell(r, 2).Value = p.Category?.Name;
            ws.Cell(r, 3).Value = p.Name;
            ws.Cell(r, 4).Value = p.Location;
            if (p.NearestExpiry is { } e) { ws.Cell(r, 5).Value = e.ToDateTime(TimeOnly.MinValue); ws.Cell(r, 5).Style.DateFormat.Format = "yyyy-mm-dd"; }
            ws.Cell(r, 6).Value = p.QtyOnHand;
            ws.Cell(r, 9).Value = p.UnitsPerCase;
            ws.Cell(r, 10).Value = p.UnitCost;
            ws.Cell(r, 11).Value = p.SellPrice;
            r++;
        }
        ws.Columns().AdjustToContents(1, Math.Min(r, 200));
        ws.SheetView.FreezeRows(1);
        using var ms = new MemoryStream();
        wb.SaveAs(ms);
        return File(ms.ToArray(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", $"count-sheet-{DateTime.Today:yyyy-MM-dd}.xlsx");
    }

    public string PageUrl(int page) => Url.Page("Index", new { Q, CategoryId, SupplierId, Location, Filter, Sort, PageNo = page })!;
}
