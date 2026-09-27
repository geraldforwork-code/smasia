using Microsoft.EntityFrameworkCore;
using SmAsia.Web.Data.Entities;

namespace SmAsia.Web.Data;

public static class DbSeeder
{
    // From the "CATEGORIES GUIDE" column of the SM ASIA inventory workbook.
    private static readonly string[] Categories =
    [
        "Beauty", "Cleaning/Household", "Spices & Condiments", "Baking", "Pasta, Rice & Cereal", "Grains", "Produce",
        "Deli/Meat/Seafood", "Bakery/Bread", "Beverages", "Dairy/Refrigerated", "Snacks", "Pantry Items", "Frozen Foods",
        "Pet Care", "Electronics", "Medicine/Health", "Cooking Tools", "Beverages/Health", "Noodles", "Non-Food",
    ];

    public static async Task SeedAsync(AppDbContext db)
    {
        if (!await db.Categories.AnyAsync())
        {
            db.Categories.AddRange(Categories.Select(c => new Category { Name = c }));
        }

        if (!await db.Suppliers.AnyAsync())
        {
            db.Suppliers.AddRange(
                new Supplier
                {
                    Name = "UNO Foods Inc.", InvoiceParserKey = "unofoods", AccountNumber = "SMA001",
                    Phone = "(604) 214-0360", Address = "#1-608 Annance Court, Delta BC V3M 6Y8",
                    Terms = "50% prepaid, 50% balance 30 days", LeadTimeDays = 10, OrderCycleDays = 28,
                },
                new Supplier
                {
                    Name = "Dong Phuong Distributor", InvoiceParserKey = "dongphuong", AccountNumber = "SMASI",
                    Phone = "(780) 447-2883", Address = "14818-131 Avenue, Edmonton, AB T5L 4Y3",
                    Terms = "0 days", LeadTimeDays = 3, OrderCycleDays = 14,
                });
        }
        await db.SaveChangesAsync();
    }
}
