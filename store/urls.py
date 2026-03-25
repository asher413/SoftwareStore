from django.urls import path
from . import views
from django.contrib.auth import views as auth_views
from django.urls import path
from . import views

urlpatterns = [
    path('', views.home, name='home'),
    path('software/<int:pk>/', views.software_detail, name='software_detail'),
    path('buy/<int:pk>/', views.buy_software, name='buy_software'),
    path('dashboard/', views.dashboard, name='dashboard'),
    path('about/', views.about, name='about'),
    path('contact/', views.contact, name='contact'),
    path('signup/', views.signup_view, name='signup'),
    
    # עגלת קניות ורכישה
    path('add-to-cart/<int:pk>/', views.add_to_cart, name='add_to_cart'),
    path('cart/', views.view_cart, name='view_cart'),
    path('apply-coupon/', views.apply_coupon, name='apply_coupon'),
    path('checkout/', views.checkout, name='checkout'),
    path('checkout-process/', views.checkout, name='checkout'),
    path('success/', views.success_page, name='success_page'),
    
    # פעולות תוכנה
    path('run/<int:software_id>/', views.run_software, name='run_software'),
    path('download/<int:software_id>/', views.secure_download, name='secure_download'),
    path('add-review/<int:software_id>/', views.add_review, name='add_review'),
    
    # ניהול
    path('admin-dashboard/', views.admin_dashboard, name='admin_dashboard'),
    
    path('login/', auth_views.LoginView.as_view(template_name='registration/login.html'), name='login'),
    path('logout/', auth_views.LogoutView.as_view(), name='logout'),
    
    # הבלוג - שים לב שמחקנו את השורה של views.blog שהייתה למעלה
    path('blog/', views.blog_view, name='blog'), 
    path('archive/', views.archive_view, name='blog_archive'),
    path('blog/<int:pk>/', views.blog_detail, name='blog_detail'),
    path('create-checkout-session/<int:product_id>/', views.create_checkout_session, name='create_checkout_session'),
    path('success/', views.payment_success, name='payment_success'), # צור פונקציה פשוטה לזה ב-views
    path('cancel/', views.payment_cancel, name='payment_cancel'),    # כנ"ל לביטול
]