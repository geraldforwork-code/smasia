using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services;

namespace SmAsia.Web.Pages.Stock;

/// <summary>Stock take: count one aisle or category at a time and post the differences.</summary>
public class CountModel(AppDbContext db, InventoryService inventory) : PageModel
{
    public class CountInput
    {
        public int ProductId { get; set; }
        public decimal? Counted { get; set; }
        public DateOnly? Expiry { get; set; }
    }

    [BindProperty(SupportsGet = true)] public string? Location { get; set; }
    [BindProperty(SupportsGet = true)] public int? CategoryId { get; set; }
    [BindProperty] public List<CountInput> Counts { get; set; } = [];
    [BindProperty] public string? Note { get; set; }

    public List<Product> Products { get; set; } = [];
    public List<string> Locations { get; set; } = [];
    public List<Category> Categories { get; set; } = [];

    public async Task OnGetAsync()
    {
        Locations = await db.Products.Where(p => p.IsActive && p.Location != null).Select(p => p.Location!).Distinct().OrderBy(l => l).ToListAsync();
        Categories = await db.Categories.OrderBy(c => c.Name).ToListAsync();
        if (Location == null && CategoryId == null) return;
        var q = db.Products.Where(p => p.IsActive);
        if (!string.IsNullOrEmpty(Location)) q = q.Where(p => p.Location == Location);
        if (CategoryId != null) q = q.Where(p => p.CategoryId == CategoryId);
        Products = await q.OrderBy(p => p.Name).ToListAsync();
        Counts = Products.Select(p => new CountInput { ProductId = p.Id, Expiry = p.NearestExpiry }).ToList();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        var ids = Counts.Select(c => c.ProductId).ToList();
        var products = await db.Products.Where(p => ids.Contains(p.Id)).ToDictionaryAsync(p => p.Id);
        var reference = $"Stock count {DateTime.Today:yyyy-MM-dd}" + (string.IsNullOrEmpty(Location) ? "" : $" {Location}");
        int changed = 0, counted = 0;
        foreach (var c in Counts)
        {
            if (!products.TryGetValue(c.ProductId, out var p)) continue;
            if (c.Expiry != p.NearestExpiry) p.NearestExpiry = c.Expiry;
            if (c.Counted == null) continue;
            counted++;
            if (inventory.SetCount(p, c.Counted.Value, reference, Note) != null) changed++;
        }
        await db.SaveChangesAsync();
        TempData["Message"] = $"{counted} items counted, {changed} quantities corrected.";
        return RedirectToPage(new { Location, CategoryId });
    }
}
