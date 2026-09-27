using System.ComponentModel.DataAnnotations;

namespace SmAsia.Web.Data.Entities;

public enum PurchaseOrderStatus { Draft, Sent, PartiallyReceived, Received, Cancelled }

public class PurchaseOrder
{
    public int Id { get; set; }
    [MaxLength(30)] public string PoNumber { get; set; } = "";
    public int SupplierId { get; set; }
    public Supplier Supplier { get; set; } = null!;
    public PurchaseOrderStatus Status { get; set; } = PurchaseOrderStatus.Draft;
    public DateOnly OrderDate { get; set; } = DateOnly.FromDateTime(DateTime.Today);
    public DateOnly? ExpectedDate { get; set; }
    [MaxLength(1000)] public string? Notes { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public List<PurchaseOrderLine> Lines { get; set; } = [];

    public decimal Total => Lines.Sum(l => l.QtyCases * l.CaseCost);
    public bool IsOpen => Status is PurchaseOrderStatus.Draft or PurchaseOrderStatus.Sent or PurchaseOrderStatus.PartiallyReceived;
}

public class PurchaseOrderLine
{
    public int Id { get; set; }
    public int PurchaseOrderId { get; set; }
    public PurchaseOrder PurchaseOrder { get; set; } = null!;
    public int ProductId { get; set; }
    public Product Product { get; set; } = null!;
    [MaxLength(50)] public string? SupplierItemCode { get; set; }
    public decimal QtyCases { get; set; }
    public int UnitsPerCase { get; set; } = 1;
    public decimal CaseCost { get; set; }
    /// <summary>Units (not cases) received so far against this line.</summary>
    public decimal QtyReceivedUnits { get; set; }

    public decimal QtyOrderedUnits => QtyCases * UnitsPerCase;
    public decimal QtyOutstandingUnits => Math.Max(0, QtyOrderedUnits - QtyReceivedUnits);
}

public enum ReceiptStatus { Draft, Posted }

/// <summary>A delivery / supplier invoice being received into stock.</summary>
public class Receipt
{
    public int Id { get; set; }
    public int SupplierId { get; set; }
    public Supplier Supplier { get; set; } = null!;
    public int? PurchaseOrderId { get; set; }
    public PurchaseOrder? PurchaseOrder { get; set; }
    [MaxLength(50)] public string? InvoiceNumber { get; set; }
    public DateOnly? InvoiceDate { get; set; }
    public DateOnly ReceivedDate { get; set; } = DateOnly.FromDateTime(DateTime.Today);
    [MaxLength(50)] public string? SupplierOrderNumber { get; set; }
    public decimal? InvoiceSubtotal { get; set; }
    public decimal? InvoiceTax { get; set; }
    public decimal? InvoiceTotal { get; set; }
    public ReceiptStatus Status { get; set; } = ReceiptStatus.Draft;
    [MaxLength(260)] public string? SourceFileName { get; set; }
    [MaxLength(2000)] public string? Notes { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? PostedAt { get; set; }
    public List<ReceiptLine> Lines { get; set; } = [];

    public decimal LinesTotal => Lines.Where(l => !l.Skip).Sum(l => l.ExtendedCost);
}

public class ReceiptLine
{
    public int Id { get; set; }
    public int ReceiptId { get; set; }
    public Receipt Receipt { get; set; } = null!;
    public int? ProductId { get; set; }
    public Product? Product { get; set; }
    public int LineNo { get; set; }
    [MaxLength(50)] public string? SupplierItemCode { get; set; }
    [MaxLength(250)] public string Description { get; set; } = "";
    [MaxLength(50)] public string? Upc { get; set; }
    public decimal QtyCases { get; set; }
    public int UnitsPerCase { get; set; } = 1;
    public decimal CaseCost { get; set; }
    public decimal ExtendedCost { get; set; }
    public bool Taxable { get; set; }
    public DateOnly? ExpiryDate { get; set; }
    /// <summary>How the product was matched (SupplierCode, Barcode, Name, Manual) — shown on review.</summary>
    [MaxLength(30)] public string? MatchMethod { get; set; }
    /// <summary>Line is ignored when posting (e.g. deposit or non-stock lines).</summary>
    public bool Skip { get; set; }

    public decimal QtyUnits => QtyCases * UnitsPerCase;
}
