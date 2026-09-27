using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services;
using SmAsia.Web.Services.Import;

namespace SmAsia.Web.Pages.Import;

public class BatchModel(AppDbContext db, SalesImporter sales, InventoryService inventory) : PageModel
{
    public ImportBatch Batch { get; set; } = null!;
    /// <summary>Unmatched rows grouped by item (an EPOS item usually appears once per day).</summary>
    public record IssueGroup(int FirstIssueId, string? Code, string? Name, int Rows, decimal Quantity, decimal Amount, DateOnly? From, DateOnly? To);
    public List<IssueGroup> Issues { get; set; } = [];
    public decimal SalesUnits { get; set; }
    public decimal SalesAmount { get; set; }
    public int ProductsAffected { get; set; }
    public List<Category> Categories { get; set; } = [];

    public async Task<IActionResult> OnGetAsync(int id)
    {
        var b = await db.ImportBatches.FindAsync(id);
        if (b == null) return NotFound();
        Batch = b;
        var issues = await db.ImportIssues.Where(i => i.ImportBatchId == id && !i.Resolved).ToListAsync();
        Issues = issues.GroupBy(i => (i.Code, i.Name))
            .Select(g => new IssueGroup(g.Min(i => i.Id), g.Key.Code, g.Key.Name, g.Count(), g.Sum(i => i.Quantity), g.Sum(i => i.Amount),
                g.Min(i => i.SaleDate), g.Max(i => i.PeriodTo ?? i.SaleDate)))
            .OrderByDescending(g => g.Amount).ToList();
        if (b.Type == ImportType.Sales)
        {
            SalesUnits = await db.SalesLines.Where(s => s.ImportBatchId == id).SumAsync(s => (decimal?)s.Quantity) ?? 0;
            SalesAmount = await db.SalesLines.Where(s => s.ImportBatchId == id).SumAsync(s => (decimal?)s.NetAmount) ?? 0;
            ProductsAffected = await db.SalesLines.Where(s => s.ImportBatchId == id).Select(s => s.ProductId).Distinct().CountAsync();
        }
        else
        {
            ProductsAffected = await db.StockMovements.Where(m => m.ImportBatchId == id).Select(m => m.ProductId).Distinct().CountAsync();
        }
        Categories = await db.Categories.OrderBy(c => c.Name).ToListAsync();
        return Page();
    }

    public async Task<IActionResult> OnPostResolveAsync(int id, int issueId, int? productId)
    {
        if (productId == null) { TempData["Error"] = "Pick a product from the list first."; return RedirectToPage(new { id }); }
        await sales.ResolveIssueAsync(issueId, productId.Value, applyToSameCode: true);
        TempData["Message"] = "Linked. Future imports will match this item automatically.";
        return RedirectToPage(new { id });
    }

    /// <summary>Creates a product from an unmatched EPOS row (barcode + name) and links the row to it.</summary>
    public async Task<IActionResult> OnPostCreateAsync(int id, int issueId, int? categoryId)
    {
        var issue = await db.ImportIssues.FirstAsync(i => i.Id == issueId && i.ImportBatchId == id);
        var digits = new string((issue.Code ?? "").Where(char.IsDigit).ToArray());
        var product = new Product
        {
            Name = string.IsNullOrWhiteSpace(issue.Name) ? issue.Code ?? "New product" : issue.Name,
            Barcode = digits.Length >= 6 ? digits : null,
            CategoryId = categoryId,
            SellPrice = issue.Quantity > 0 && issue.Amount > 0 ? Math.Round(issue.Amount / issue.Quantity, 2) : 0,
        };
        db.Products.Add(product);
        // Stock tracking starts now; earlier sales still count towards the forecast but aren't deducted.
        inventory.Move(product, MovementType.Opening, 0, "Created from EPOS import", "Count this item to set its stock");
        await db.SaveChangesAsync();
        await sales.ResolveIssueAsync(issueId, product.Id, applyToSameCode: true);
        TempData["Message"] = $"Created \"{product.Name}\" and linked its sales.";
        return RedirectToPage(new { id });
    }

    public async Task<IActionResult> OnPostReverseAsync(int id)
    {
        var b = await db.ImportBatches.FindAsync(id);
        if (b == null) return NotFound();
        if (b.Type == ImportType.Sales)
        {
            await sales.ReverseAsync(id);
            TempData["Message"] = "Import reversed: its sales were removed and stock restored.";
        }
        else if (b.Type == ImportType.Inventory && !b.Reversed)
        {
            // Undo the stock changes; product details that were updated are kept.
            var movements = await db.StockMovements.Include(m => m.Product).Where(m => m.ImportBatchId == id).ToListAsync();
            foreach (var m in movements)
                inventory.Move(m.Product, MovementType.Adjustment, -m.Quantity, $"Reverse inventory import #{id}");
            b.Reversed = true;
            await db.SaveChangesAsync();
            TempData["Message"] = "Stock changes from this import were reversed (product details were kept).";
        }
        return RedirectToPage(new { id });
    }
}
