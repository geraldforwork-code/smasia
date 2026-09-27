using System.ComponentModel.DataAnnotations;

namespace SmAsia.Web.Data.Entities;

public class Category
{
    public int Id { get; set; }
    [Required, MaxLength(100)] public string Name { get; set; } = "";
    public List<Product> Products { get; set; } = [];
}

public class Supplier
{
    public int Id { get; set; }
    [Required, MaxLength(150)] public string Name { get; set; } = "";
    [MaxLength(50)] public string? AccountNumber { get; set; }
    [MaxLength(100)] public string? ContactName { get; set; }
    [MaxLength(50)] public string? Phone { get; set; }
    [MaxLength(150), EmailAddress] public string? Email { get; set; }
    [MaxLength(300)] public string? Address { get; set; }
    [MaxLength(100)] public string? Terms { get; set; }

    /// <summary>Days from placing an order to receiving it.</summary>
    [Range(0, 365)] public int LeadTimeDays { get; set; } = 7;

    /// <summary>How often this supplier is ordered from; stock must cover lead time + this.</summary>
    [Range(1, 365)] public int OrderCycleDays { get; set; } = 14;

    /// <summary>Which invoice PDF parser handles this supplier's invoices (e.g. "unofoods").</summary>
    [MaxLength(50)] public string? InvoiceParserKey { get; set; }

    [MaxLength(1000)] public string? Notes { get; set; }
    public bool IsActive { get; set; } = true;

    public List<SupplierProduct> Products { get; set; } = [];
}

public class Product
{
    public int Id { get; set; }
    [MaxLength(50)] public string? Barcode { get; set; }
    [Required, MaxLength(200)] public string Name { get; set; } = "";
    public int? CategoryId { get; set; }
    public Category? Category { get; set; }
    [MaxLength(100)] public string? Location { get; set; }

    /// <summary>Sellable units in one supplier case.</summary>
    public int UnitsPerCase { get; set; } = 1;

    /// <summary>Weighted average cost per sellable unit.</summary>
    public decimal UnitCost { get; set; }
    public decimal SellPrice { get; set; }

    public decimal QtyOnHand { get; set; }

    /// <summary>Manual floor: always reorder when stock drops below this, even with no sales history.</summary>
    public decimal MinStock { get; set; }

    public DateOnly? NearestExpiry { get; set; }

    public int? PreferredSupplierId { get; set; }
    public Supplier? PreferredSupplier { get; set; }

    public bool IsActive { get; set; } = true;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public List<SupplierProduct> SupplierProducts { get; set; } = [];
    public List<ProductAlias> Aliases { get; set; } = [];
}

/// <summary>A supplier's item code for a product, learned when invoices are received.</summary>
public class SupplierProduct
{
    public int Id { get; set; }
    public int SupplierId { get; set; }
    public Supplier Supplier { get; set; } = null!;
    public int ProductId { get; set; }
    public Product Product { get; set; } = null!;
    [MaxLength(50)] public string SupplierItemCode { get; set; } = "";
    [MaxLength(250)] public string? SupplierDescription { get; set; }
    public int UnitsPerCase { get; set; } = 1;
    public decimal LastCaseCost { get; set; }
    public DateOnly? LastReceivedOn { get; set; }
}

/// <summary>An alternate code/name that identifies a product in an EPOS or other external report.</summary>
public class ProductAlias
{
    public int Id { get; set; }
    public int ProductId { get; set; }
    public Product Product { get; set; } = null!;
    [MaxLength(100)] public string? Code { get; set; }
    [MaxLength(250)] public string? Name { get; set; }
}
