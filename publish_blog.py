import os
from django.core.management.base import BaseCommand
from google import genai
# תיקון ה-Import: מייבאים ישירות מהאפליקציה ולא בצורה יחסית

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'myproject.settings') # שנה למה שמתאים לך
django.setup()

from store.models import BlogPost

class Command(BaseCommand):
    help = 'מייצר מאמר טכנולוגי חדש לבלוג'

    def handle(self, *args, **options):
        # הגדרות ה-SSL (חובה להשאיר עבור סביבות מסוימות)
        ca_path = r'C:\Users\USER\AppData\Local\.certifi\cacert.pem' 
        os.environ['SSL_CERT_FILE'] = ca_path
        os.environ['GRPC_DEFAULT_SSL_ROOTS_FILE_PATH'] = ca_path

        # יצירת הלקוח
        client = genai.Client(
            api_key="AIzaSyD218mWofUsl6UwHkTSTWwTQvDbm008gDY",
            http_options={'api_version': 'v1beta'}
        )

        prompt = """
            כתוב מאמר מקצועי, מעשיר וחינוכי בעברית עבור בלוג תוכנה. 
            המאמר צריך לעסוק באחד מהנושאים הבאים: 
            1. מדריך טכני על שפת תכנות (כמו Python או JavaScript).
            2. טיפים להתייעלות בעבודה עם מחשב ותוכנות פרודוקטיביות.
            3. הסבר על מושג מעולם הפיתוח (למשל: מה זה API, איך עובד מסד נתונים).

            דגשים:
            - השפה צריכה להיות מכובדת, נקייה וברורה.
            - המבנה: שורה ראשונה היא הכותרת, ולאחריה תוכן המאמר מחולק לפסקאות.
            - הימנע משימוש בסלנג או בנושאים שאינם קשורים ישירות לטכנולוגיה.
        """

        try:
            self.stdout.write("סורק מודלים זמינים בחשבון...")
            models = client.models.list()
            
            # מציאת המודל המתאים ביותר
            target_model = next((m.name for m in models if 'flash' in m.name.lower()), None)
            
            if not target_model:
                self.stdout.write(self.style.ERROR("לא נמצא מודל מתאים ברשימה."))
                return

            self.stdout.write(f"נבחר מודל: {target_model}. מנסה ליצור תוכן...")

            # יצירת התוכן
            response = client.models.generate_content(
                model=target_model,
                contents=prompt
            )

            if response and response.text:
                full_text = response.text
                lines = [l.strip() for l in full_text.split('\n') if l.strip()]
                
                if lines:
                    title = lines[0].replace('#', '').replace('*', '')
                    content = '\n'.join(lines[1:])
                
                    # שמירה למסד הנתונים
                    BlogPost.objects.create(title=title, content=content)
                    self.stdout.write(self.style.SUCCESS(f"בוצע בהצלחה! המאמר '{title}' נשמר."))
                else:
                    self.stdout.write(self.style.WARNING("התקבלה תגובה ריקה מהמודל."))

        except Exception as e:
            self.stdout.write(self.style.ERROR(f"נעצר בשל שגיאה: {e}"))