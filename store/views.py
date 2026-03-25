import os
from django.shortcuts import render, get_object_or_404, redirect
from .models import Software, Purchase, Review
from django.contrib.auth.decorators import login_required
from django.utils import timezone
from django.contrib import messages
from .models import Coupon, Purchase, Software
from datetime import timedelta
from .models import Category, Software # וודא ש-Category מיובא
from django.contrib.auth.decorators import user_passes_test
from django.core.mail import send_mail
from django.conf import settings
from django.db.models import Sum
from django.http import FileResponse, HttpResponseForbidden
from django.shortcuts import render
from .models import BlogPost, SiteAnnouncement  # הוסף כאן את SiteAnnouncement
import stripe
from django.shortcuts import redirect
from django.urls import reverse

stripe.api_key = settings.STRIPE_SECRET_KEY

def home(request):
    softwares = Software.objects.all()
    return render(request, 'store/home.html', {'softwares': softwares})

def software_detail(request, pk):
    software = get_object_or_404(Software, pk=pk)
    return render(request, 'store/detail.html', {'software': software})

@login_required
def run_software(request, software_id):
    software = get_object_or_404(Software, id=software_id)
    # מחפש רכישה פעילה (לא פגה)
    purchase = Purchase.objects.filter(
        user=request.user, 
        software=software, 
        expiry_date__gt=timezone.now()
    ).first()

    if purchase:
        return render(request, 'store/run_app.html', {'software': software})
    else:
        messages.error(request, "הרישיון פג או שלא נרכשה תוכנה זו. ניתן לחדש רישיון בעגלת הקניות.")
        return redirect('software_detail', pk=software_id)
    
# עגלת קניות
def add_to_cart(request, pk):
    cart = request.session.get('cart', [])
    if pk not in cart:
        cart.append(pk)
        messages.success(request, "התוכנה נוספה לעגלה!")
    request.session['cart'] = cart
    return redirect('home')

def view_cart(request):
    cart_ids = request.session.get('cart', [])
    softwares = Software.objects.filter(id__in=cart_ids)
    total = sum(s.price for s in softwares)
    return render(request, 'store/cart.html', {'softwares': softwares, 'total': total})

# שאר הפונקציות הקיימות (about, contact וכו'...)
def about(request):
    return render(request, 'store/about.html')

def contact(request):
    if request.method == 'POST':
        name = request.POST.get('name')
        email = request.POST.get('email')
        message = request.POST.get('message')
        
        # בניית המייל
        subject = f"הודעה חדשה מ-A.B תכנות: {name}"
        full_message = f"מאת: {name} ({email})\n\n{message}"
        
        try:
            send_mail(subject, full_message, settings.EMAIL_HOST_USER, [settings.EMAIL_HOST_USER])
            messages.success(request, "ההודעה נשלחה בהצלחה! נחזור אליך בקרוב.")
        except Exception as e:
            messages.error(request, f"שגיאה בשליחת המייל: {e}")
            
    return render(request, 'store/contact.html')

@login_required
def dashboard(request):
    # מביא את כל הרכישות של המשתמש המחובר כולל נתוני התוכנה
    purchases = Purchase.objects.filter(user=request.user).select_related('software')
    return render(request, 'store/dashboard.html', {'purchases': purchases})

def buy_software(request, pk):
    # לוגיקת רכישה זמנית עד שנחבר את Stripe
    soft = get_object_or_404(Software, pk=pk)
    Purchase.objects.create(user=request.user, software=soft)
    return render(request, 'store/success.html', {'software': soft})

def blog(request):
    return render(request, 'store/blog.html')

def signup_view(request):
    # אם יש לך כבר פונקציית הרשמה, תשאיר אותה כאן
    return render(request, 'registration/signup.html')

def apply_coupon(request):
    if request.method == "POST":
        code = request.POST.get('code', '').strip()
        # חיפוש קופון תואם ופעיל
        coupon = Coupon.objects.filter(code__iexact=code, is_active=True).first()
        
        if coupon.allows_download:
            request.session['allow_download'] = True
            request.session.modified = True  # מכריח את דג'נגו לעדכן את הזיכרון
        
        if coupon:
            # 1. עדכון אחוז ההנחה בסשן
            request.session['coupon_discount'] = int(coupon.discount_percent)
            
            # 2. בדיקה האם הקופון מאפשר הורדה (VIP)
            if hasattr(coupon, 'allows_download') and coupon.allows_download:
                request.session['allow_download'] = True
                messages.success(request, f"קוד VIP הופעל! גישת הורדה נפתחה + {coupon.discount_percent}% הנחה.")
            else:
                # אם זה קופון רגיל, נבטל הרשאת הורדה קודמת אם הייתה
                request.session['allow_download'] = False
                messages.success(request, f"קופון הופעל: {coupon.discount_percent}% הנחה הוספה לעגלה.")
        else:
            messages.error(request, "קוד קופון לא תקף או פג תוקף.")
            
    return redirect('view_cart')

def view_cart(request):
    cart_ids = request.session.get('cart', [])
    softwares = Software.objects.filter(id__in=cart_ids)
    
    # חישוב מחיר מקורי
    original_total = sum(s.price for s in softwares)
    
    # משיכת הנחה מהסשן
    discount_percent = request.session.get('coupon_discount', 0)
    discount_amount = (original_total * discount_percent) / 100
    final_total = original_total - discount_amount

    return render(request, 'store/cart.html', {
        'softwares': softwares,
        'original_total': original_total,
        'discount_amount': discount_amount,
        'total': final_total, # זה המשתנה שצריך להופיע ב-HTML כסה"כ
        'discount_percent': discount_percent
    })

def home(request):
    categories = Category.objects.all()
    # אפשרות לסנן לפי קטגוריה אם לחצו עליה בתפריט
    category_id = request.GET.get('category')
    if category_id:
        softwares = Software.objects.filter(category_id=category_id)
    else:
        softwares = Software.objects.all()
        
    return render(request, 'store/home.html', {'softwares': softwares, 'categories': categories})

@user_passes_test(lambda u: u.is_superuser)
def admin_stats(request):
    total_sales = Purchase.objects.count()
    total_users = User.objects.count()
    recent_purchases = Purchase.objects.order_by('-purchase_date')[:10]
    return render(request, 'store/admin_stats.html', {
        'total_sales': total_sales,
        'total_users': total_users,
        'recent_purchases': recent_purchases
    })

@login_required
def add_review(request, software_id):
    if request.method == "POST":
        software = get_object_or_404(Software, id=software_id)
        rating = request.POST.get('rating')
        comment = request.POST.get('comment')
        
        # יצירת הביקורת
        Review.objects.create(
            software=software,
            user=request.user,
            rating=int(rating),
            comment=comment
        )
        messages.success(request, "תודה! הביקורת שלך פורסמה.")
    return redirect('software_detail', pk=software_id)

@login_required
def admin_dashboard(request):
    if not request.user.is_superuser:
        return redirect('home') # רק מנהל יכול להיכנס

    context = {
        'users_count': User.objects.count(),
        'revenue': Purchase.objects.aggregate(Sum('software__price'))['software__price__sum'] or 0,
        'recent_purchases': Purchase.objects.all().order_by('-purchase_date')[:10],
        'coupons': Coupon.objects.all(),
        'active_licenses_count': Purchase.objects.filter(expiry_date__gt=timezone.now()).count()
    }
    return render(request, 'store/admin_dashboard.html', context)

@login_required
def checkout(request):
    cart_ids = request.session.get('cart', [])
    if not cart_ids:
        return redirect('home')
    
    softwares = Software.objects.filter(id__in=cart_ids)
    
    # יצירת רכישה לכל תוכנה בעגלה
    for sw in softwares:
        Purchase.objects.create(
            user=request.user,
            software=sw,
            expiry_date=timezone.now() + timedelta(days=30)
        )
    
    # ניקוי העגלה והקופון
    request.session['cart'] = []
    request.session['coupon_discount'] = 0
    
    return redirect('success_page')

def success_page(request):
    return render(request, 'store/success.html')

def secure_download(request, software_id):
    if not request.session.get('allow_download', False):
        return HttpResponse("גישת VIP נדרשת", status=403)

    software = get_object_or_404(Software, id=software_id)
    
    # שימוש בשם השדה החדש שהוספנו
    if software.software_file:
        file_path = software.software_file.path
        if os.path.exists(file_path):
            return FileResponse(open(file_path, 'rb'), as_attachment=True)
    
    messages.error(request, "הקובץ לא קיים בשרת. וודא שהעלית קובץ ב-Admin.")
    return redirect('dashboard')

def home(request):
    categories = Category.objects.all()
    # שליפת הודעה פעילה אחת (האחרונה שפורסמה)
    announcement = SiteAnnouncement.objects.filter(is_active=True).last()
    
    category_id = request.GET.get('category')
    if category_id:
        softwares = Software.objects.filter(category_id=category_id)
    else:
        softwares = Software.objects.all()
        
    return render(request, 'store/home.html', {
        'softwares': softwares, 
        'categories': categories,
        'announcement': announcement # הוספת המשתנה ל-Template
    })

def blog_view(request):
    # שליפת כל המאמרים
    all_posts = BlogPost.objects.all().order_by('-created_at')
    
    # חשוב מאוד: המפתח במילון חייב להיות 'posts'
    return render(request, 'store/blog.html', {'posts': all_posts})

def blog_detail(request, pk):
    post = get_object_or_404(BlogPost, pk=pk)
    return render(request, 'store/blog_detail.html', {'post': post})

def archive_view(request):
    # שולף את כל המאמרים ומדלג על הראשון (שהוא הכי חדש)
    archive_posts = BlogPost.objects.all().order_by('-created_at')[1:]
    return render(request, 'store/archive.html', {'archive_posts': archive_posts})

def create_checkout_session(request, product_id):
    # כאן אנחנו מגדירים את פרטי התשלום
    # בגרסה מתקדמת נשלוף את מחיר המוצר מה-Database לפי product_id
    try:
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=['card'],
            line_items=[
                {
                    'price_data': {
                        'currency': 'ils', # שקלים
                        'product_data': {
                            'name': 'תוכנה מבית SoftwareStore',
                        },
                        'unit_amount': 5000, # מחיר באגורות (5000 אגורות = 50 ש"ח)
                    },
                    'quantity': 1,
                },
            ],
            mode='payment',
            # לאן המשתמש יחזור אחרי הצלחה או ביטול
            success_url=request.build_absolute_uri(reverse('payment_success')),
            cancel_url=request.build_absolute_uri(reverse('payment_cancel')),
        )
        return redirect(checkout_session.url, code=303)
    except Exception as e:
        return str(e)
    
def payment_success(request):
    return render(request, 'store/success.html')

def payment_cancel(request):
    return render(request, 'store/cancel.html')