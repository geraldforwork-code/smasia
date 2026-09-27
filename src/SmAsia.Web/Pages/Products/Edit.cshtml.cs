using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data;
using SmAsia.Web.Data.Entities;
using SmAsia.Web.Services;

namespace SmAsia.Web.Pages.Products;

public class EditModel(AppDbContext db, InventoryService inventory) : PageModel
{
    [BindProperty] public Product Product { get; set; } = new();
    [BindProperty] public string? NewCategory { get; set; }
    [BindProperty] public decimal? OpeningStock { get; set; }

    public List<Category> Categories { get; set; } = [];
    public List<Supplier> Suppliers { get; set; } = [];

    public async Task<IActionResult> OnGetAsync(int? id)
    {
        if (id != null)
        {
            var p = await db.Products.FindAsync(id);
            if (p == null) return NotFound();
            Product = p;
        }
        await LoadListsAsync();
        return Page();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        ModelState.Remove("Product.Category");
        ModelState.Remove("Product.PreferredSupplier");
        if (!string.IsNullOrWhiteSpace(Product.Barcode))
        {
            Product.Barcode = Product.Barcode.Trim();
            var dup = await db.Products.Where(p => p.Barcode == Product.Barcode && p.Id != Product.Id).Select(p => p.Name).FirstOrDefaultAsync();
            if (dup != null) ModelState.AddModelError("Product.Barcode", $"This barcode is already used by \"{dup}\".");
        }
        if (Product.UnitsPerCase < 1) ModelState.AddModelError("Product.UnitsPerCase", "Must be at least 1.");
        if (!ModelState.IsValid)
        {
            await LoadListsAsync();
            return Page();
        }

        if (!string.IsNullOrWhiteSpace(NewCategory))
        {
            var name = NewCategory.Trim();
            var cat = await db.Categories.FirstOrDefaultAsync(c => c.Name == name) ?? db.Categories.Add(new Category { Name = name }).Entity;
            Product.Category = cat;
        }

        if (Product.Id == 0)
        {
            db.Products.Add(Product);
            if (OpeningStock is { } q && q != 0)
                inventory.Move(Product, MovementType.Opening, q, "Opening stock");
        }
        else
        {
            var existing = await db.Products.FindAsync(Product.Id);
            if (existing == null) return NotFound();
            // On-hand quantity only changes through stock movements.
            Product.QtyOnHand = existing.QtyOnHand;
            Product.CreatedAt = existing.CreatedAt;
            Product.UpdatedAt = DateTime.UtcNow;
            db.Entry(existing).CurrentValues.SetValues(Product);
            if (Product.Category != null) existing.Category = Product.Category;
        }
        await db.SaveChangesAsync();
        TempData["Message"] = $"Saved \"{Product.Name}\".";
        return RedirectToPage("Details", new { id = Product.Id });
    }

    private async Task LoadListsAsync()
    {
        Categories = await db.Categories.OrderBy(c => c.Name).ToListAsync();
        Suppliers = await db.Suppliers.Where(s => s.IsActive).OrderBy(s => s.Name).ToListAsync();
    }
}
