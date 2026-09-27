using System.ComponentModel.DataAnnotations;

namespace SmAsia.Web.Data.Entities;

public enum MovementType { Opening, Receipt, Sale, Count, Adjustment, Wastage }

/// <summary>Every change to on-hand stock is recorded here; Product.QtyOnHand is the running total.</summary>
public class StockMovement
{
    public long Id { get; set; }
    public int ProductId { get; set; }
    public Product Product { get; set; } = null!;
    public DateTime OccurredAt { get; set; } = DateTime.Now;
    public MovementType Type { get; set; }
    /// <summary>Signed change in units (+ in, − out).</summary>
    public decimal Quantity { get; set; }
    public decimal QtyAfter { get; set; }
    public decimal? UnitCost { get; set; }
    [MaxLength(100)] public string? Reference { get; set; }
    [MaxLength(500)] public string? Note { get; set; }
    public int? ReceiptId { get; set; }
    public int? ImportBatchId { get; set; }
}

/// <summary>Units sold per product per day, from EPOS report imports.</summary>
public class SalesLine
{
    public long Id { get; set; }
    public int ProductId { get; set; }
    public Product Product { get; set; } = null!;
    public DateOnly SaleDate { get; set; }
    public decimal Quantity { get; set; }
    public decimal NetAmount { get; set; }
    public int ImportBatchId { get; set; }
    public ImportBatch ImportBatch { get; set; } = null!;
}

public enum ImportType { Sales, Inventory, SupplierInvoice }

public class ImportBatch
{
    public int Id { get; set; }
    public ImportType Type { get; set; }
    [MaxLength(260)] public string FileName { get; set; } = "";
    [MaxLength(64)] public string? FileHash { get; set; }
    public DateTime ImportedAt { get; set; } = DateTime.Now;
    public DateOnly? PeriodFrom { get; set; }
    public DateOnly? PeriodTo { get; set; }
    public int RowsRead { get; set; }
    public int RowsImported { get; set; }
    public int RowsUnmatched { get; set; }
    public int RowsSkipped { get; set; }
    public bool AffectedStock { get; set; }
    public bool Reversed { get; set; }
    [MaxLength(4000)] public string? Log { get; set; }
    public List<ImportIssue> Issues { get; set; } = [];
}

/// <summary>A row from an import that could not be matched to a product; can be resolved later.</summary>
public class ImportIssue
{
    public int Id { get; set; }
    public int ImportBatchId { get; set; }
    public ImportBatch ImportBatch { get; set; } = null!;
    [MaxLength(100)] public string? Code { get; set; }
    [MaxLength(250)] public string? Name { get; set; }
    public DateOnly? SaleDate { get; set; }
    public DateOnly? PeriodTo { get; set; }
    public decimal Quantity { get; set; }
    public decimal Amount { get; set; }
    public bool Resolved { get; set; }
}

/// <summary>Column mapping remembered for a report layout (keyed by its header signature).</summary>
public class ImportProfile
{
    public int Id { get; set; }
    public ImportType Type { get; set; }
    [MaxLength(64)] public string HeaderSignature { get; set; } = "";
    [MaxLength(100)] public string Name { get; set; } = "";
    public string MappingJson { get; set; } = "{}";
    public DateTime UpdatedAt { get; set; } = DateTime.Now;
}
